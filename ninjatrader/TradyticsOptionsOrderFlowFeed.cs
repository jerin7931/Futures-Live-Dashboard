#region Using declarations
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    /// <summary>
    /// Low-latency ES/NQ feature bridge for the Tradytics Options Command service.
    ///
    /// The market-data callbacks only update fixed-size in-memory buckets. A timer
    /// emits compact snapshots over loopback UDP, so NinjaTrader never waits for a
    /// database, website, or language model. This AddOn does not place orders.
    /// </summary>
    public class TradyticsOptionsOrderFlowFeed : AddOnBase
    {
        private const string SourceVersion = "TRADYTICS_OPTIONS_ORDERFLOW_NT_1_0_0";
        private const string EsContract = "ES 09-26";
        private const string NqContract = "NQ 09-26";
        private const int SnapshotMs = 100;
        private const int BucketMs = 100;
        private const int BucketCount = 64;
        private const int UdpPort = 48636;

        private readonly Dictionary<string, InstrumentState> states = new Dictionary<string, InstrumentState>(StringComparer.OrdinalIgnoreCase);
        private readonly object outputGate = new object();
        private UdpClient udp;
        private Timer snapshotTimer;
        private StreamWriter auditWriter;
        private int snapshotBusy;
        private long sequence;
        private DateTime lastAuditWriteUtc = DateTime.MinValue;

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Name = "TradyticsOptionsOrderFlowFeed";
                Description = "ES/NQ L1 + depth feature feed for paper options decision support.";
            }
            else if (State == State.Active)
            {
                StartFeed();
            }
            else if (State == State.Terminated)
            {
                StopFeed();
            }
        }

        private void StartFeed()
        {
            try
            {
                string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Futures Dashboard V28", "nt_feed");
                Directory.CreateDirectory(root);
                string auditPath = Path.Combine(root, "options_orderflow.jsonl");
                auditWriter = new StreamWriter(new FileStream(auditPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite, 65536), new UTF8Encoding(false), 65536);
                auditWriter.AutoFlush = false;

                udp = new UdpClient();
                udp.Client.SendTimeout = 1;
                udp.Connect("127.0.0.1", UdpPort);

                AddInstrument("ES", EsContract, 0.25, 20);
                AddInstrument("NQ", NqContract, 0.25, 10);
                snapshotTimer = new Timer(PublishSnapshots, null, SnapshotMs, SnapshotMs);
                Log("active; ES and NQ subscriptions requested on UDP 127.0.0.1:" + UdpPort.ToString(CultureInfo.InvariantCulture));
            }
            catch (Exception ex)
            {
                Log("startup failed: " + ex);
                StopFeed();
            }
        }

        private void AddInstrument(string symbol, string contract, double tickSize, int largeTradeThreshold)
        {
            Instrument instrument = Instrument.GetInstrument(contract);
            if (instrument == null)
                throw new InvalidOperationException("NinjaTrader could not resolve " + contract + ". Open the contract once and reload NinjaScript.");

            var state = new InstrumentState(symbol, contract, instrument, tickSize, largeTradeThreshold, BucketCount);
            states[contract] = state;
            if (!instrument.Dispatcher.HasShutdownStarted)
            {
                instrument.Dispatcher.InvokeAsync(() =>
                {
                    instrument.MarketData.Update += OnMarketData;
                    instrument.MarketDepth.Update += OnMarketDepth;
                    state.Subscribed = true;
                });
            }
        }

        private void OnMarketData(object sender, MarketDataEventArgs e)
        {
            try
            {
                if (e == null || e.Instrument == null)
                    return;
                InstrumentState state;
                if (!states.TryGetValue(e.Instrument.FullName, out state))
                    return;

                lock (state.Sync)
                {
                    state.LastEventUtc = DateTime.UtcNow;
                    state.ProviderEventUtc = e.Time.ToUniversalTime();
                    switch (e.MarketDataType)
                    {
                        case MarketDataType.Bid:
                            state.Bid = e.Price;
                            state.BidSize = e.Volume;
                            break;
                        case MarketDataType.Ask:
                            state.Ask = e.Price;
                            state.AskSize = e.Volume;
                            break;
                        case MarketDataType.Last:
                            ProcessTrade(state, e);
                            break;
                    }
                }
            }
            catch (Exception ex)
            {
                Log("market-data callback: " + ex.Message);
            }
        }

        private static void ProcessTrade(InstrumentState state, MarketDataEventArgs e)
        {
            long nowMs = UnixMs(DateTime.UtcNow);
            string sessionKey = SessionKey(DateTime.UtcNow);
            if (!String.Equals(state.SessionKey, sessionKey, StringComparison.Ordinal))
            {
                state.ResetSession(sessionKey);
            }

            long bucketId = nowMs / BucketMs;
            int index = (int)(bucketId % state.BucketIds.Length);
            if (state.BucketIds[index] != bucketId)
            {
                state.BucketIds[index] = bucketId;
                state.Buy[index] = 0;
                state.Sell[index] = 0;
                state.Total[index] = 0;
                state.Trades[index] = 0;
                state.LargeTrades[index] = 0;
                state.FirstPrice[index] = Double.NaN;
                state.LastPrice[index] = Double.NaN;
            }

            long size = Math.Max(0L, e.Volume);
            double ask = e.Ask > 0 ? e.Ask : state.Ask;
            double bid = e.Bid > 0 ? e.Bid : state.Bid;
            int side = 0;
            if (ask > 0 && e.Price >= ask - state.TickSize * 0.1)
                side = 1;
            else if (bid > 0 && e.Price <= bid + state.TickSize * 0.1)
                side = -1;
            else if (!Double.IsNaN(state.Last))
                side = e.Price > state.Last ? 1 : (e.Price < state.Last ? -1 : state.LastAggressor);

            if (side > 0)
            {
                state.Buy[index] += size;
                state.CumulativeDelta += size;
            }
            else if (side < 0)
            {
                state.Sell[index] += size;
                state.CumulativeDelta -= size;
            }
            state.Total[index] += size;
            state.Trades[index] += 1;
            if (size >= state.LargeTradeThreshold)
                state.LargeTrades[index] += 1;
            if (Double.IsNaN(state.FirstPrice[index]))
                state.FirstPrice[index] = e.Price;
            state.LastPrice[index] = e.Price;
            state.LastAggressor = side;
            state.Last = e.Price;
            state.LastSize = size;
            state.SessionVolume += size;
            state.PriceVolume += e.Price * size;
        }

        private void OnMarketDepth(object sender, MarketDepthEventArgs e)
        {
            try
            {
                if (e == null || e.Instrument == null)
                    return;
                InstrumentState state;
                if (!states.TryGetValue(e.Instrument.FullName, out state))
                    return;

                lock (state.Sync)
                {
                    state.LastDepthUtc = DateTime.UtcNow;
                    state.BookBidVolume = 0;
                    state.BookAskVolume = 0;
                    int bidCount = Math.Min(5, state.Instrument.MarketDepth.Bids.Count);
                    int askCount = Math.Min(5, state.Instrument.MarketDepth.Asks.Count);
                    for (int i = 0; i < bidCount; i++)
                        state.BookBidVolume += Math.Max(0L, state.Instrument.MarketDepth.Bids[i].Volume);
                    for (int i = 0; i < askCount; i++)
                        state.BookAskVolume += Math.Max(0L, state.Instrument.MarketDepth.Asks[i].Volume);
                    if (bidCount > 0)
                    {
                        state.Bid = state.Instrument.MarketDepth.Bids[0].Price;
                        state.BidSize = state.Instrument.MarketDepth.Bids[0].Volume;
                    }
                    if (askCount > 0)
                    {
                        state.Ask = state.Instrument.MarketDepth.Asks[0].Price;
                        state.AskSize = state.Instrument.MarketDepth.Asks[0].Volume;
                    }
                }
            }
            catch (Exception ex)
            {
                Log("market-depth callback: " + ex.Message);
            }
        }

        private void PublishSnapshots(object ignored)
        {
            if (Interlocked.Exchange(ref snapshotBusy, 1) != 0)
                return;
            try
            {
                long nowMs = UnixMs(DateTime.UtcNow);
                foreach (InstrumentState state in states.Values)
                {
                    long started = Stopwatch.GetTimestamp();
                    string line;
                    lock (state.Sync)
                    {
                        line = BuildSnapshot(state, nowMs, started);
                    }
                    byte[] bytes = Encoding.UTF8.GetBytes(line);
                    try
                    {
                        if (udp != null)
                            udp.Send(bytes, bytes.Length);
                    }
                    catch (SocketException)
                    {
                        // UDP is intentionally lossy: never block the NinjaTrader data thread.
                    }

                    DateTime nowUtc = DateTime.UtcNow;
                    if ((nowUtc - lastAuditWriteUtc).TotalSeconds >= 1.0)
                    {
                        lock (outputGate)
                        {
                            if (auditWriter != null)
                            {
                                auditWriter.WriteLine(line);
                                auditWriter.Flush();
                            }
                        }
                    }
                }
                if ((DateTime.UtcNow - lastAuditWriteUtc).TotalSeconds >= 1.0)
                    lastAuditWriteUtc = DateTime.UtcNow;
            }
            catch (Exception ex)
            {
                Log("snapshot publisher: " + ex.Message);
            }
            finally
            {
                Volatile.Write(ref snapshotBusy, 0);
            }
        }

        private string BuildSnapshot(InstrumentState state, long nowMs, long startedTicks)
        {
            long buy1 = 0, sell1 = 0, total1 = 0, trades1 = 0, large1 = 0;
            long buy5 = 0, sell5 = 0;
            double firstPrice1 = Double.NaN;
            long currentBucket = nowMs / BucketMs;
            for (int i = 0; i < state.BucketIds.Length; i++)
            {
                long age = currentBucket - state.BucketIds[i];
                if (age >= 0 && age < 50)
                {
                    buy5 += state.Buy[i];
                    sell5 += state.Sell[i];
                }
                if (age >= 0 && age < 10)
                {
                    buy1 += state.Buy[i];
                    sell1 += state.Sell[i];
                    total1 += state.Total[i];
                    trades1 += state.Trades[i];
                    large1 += state.LargeTrades[i];
                    if (!Double.IsNaN(state.FirstPrice[i]) && (Double.IsNaN(firstPrice1) || state.BucketIds[i] < state.FirstPriceBucket))
                    {
                        firstPrice1 = state.FirstPrice[i];
                        state.FirstPriceBucket = state.BucketIds[i];
                    }
                }
            }
            state.FirstPriceBucket = Int64.MaxValue;

            long delta1 = buy1 - sell1;
            long delta5 = buy5 - sell5;
            long bookTotal = state.BookBidVolume + state.BookAskVolume;
            double bookImbalance = bookTotal > 0 ? (double)(state.BookBidVolume - state.BookAskVolume) / bookTotal : 0.0;
            double deltaNorm1 = total1 > 0 ? (double)delta1 / total1 : 0.0;
            long total5 = buy5 + sell5;
            double deltaNorm5 = total5 > 0 ? (double)delta5 / total5 : 0.0;
            double priceMoveTicks = !Double.IsNaN(firstPrice1) && !Double.IsNaN(state.Last) ? (state.Last - firstPrice1) / state.TickSize : 0.0;
            double flowScore = Clamp(0.40 * deltaNorm1 + 0.20 * deltaNorm5 + 0.25 * bookImbalance + 0.15 * Math.Tanh(priceMoveTicks / 4.0), -1.0, 1.0);
            double absorptionScore = total1 > 0 && Math.Abs(priceMoveTicks) <= 2.0
                ? Clamp(Math.Abs(deltaNorm1) * Math.Min(1.0, total1 / (state.Symbol == "ES" ? 500.0 : 300.0)), 0.0, 1.0)
                : 0.0;
            string absorptionSide = absorptionScore >= 0.35 ? (delta1 > 0 ? "SELL" : "BUY") : "NONE";
            double spreadTicks = state.Ask > 0 && state.Bid > 0 ? (state.Ask - state.Bid) / state.TickSize : Double.NaN;
            double microprice = state.Ask > 0 && state.Bid > 0 && state.BidSize + state.AskSize > 0
                ? (state.Ask * state.BidSize + state.Bid * state.AskSize) / (state.BidSize + state.AskSize)
                : Double.NaN;
            double sessionVwap = state.SessionVolume > 0 ? state.PriceVolume / state.SessionVolume : Double.NaN;
            double engineUs = (Stopwatch.GetTimestamp() - startedTicks) * 1000000.0 / Stopwatch.Frequency;
            double eventAgeMs = state.LastEventUtc == DateTime.MinValue ? Double.NaN : Math.Max(0.0, (DateTime.UtcNow - state.LastEventUtc).TotalMilliseconds);

            var sb = new StringBuilder(1024);
            sb.Append('{');
            J(sb, "type", "options_orderflow_snapshot");
            J(sb, "source_version", SourceVersion);
            I(sb, "sequence", Interlocked.Increment(ref sequence));
            J(sb, "symbol", state.Symbol);
            J(sb, "contract", state.Contract);
            J(sb, "event_time", Iso(state.ProviderEventUtc == DateTime.MinValue ? DateTime.UtcNow : state.ProviderEventUtc));
            J(sb, "received_utc", Iso(DateTime.UtcNow));
            NullableN(sb, "bid", state.Bid);
            NullableN(sb, "ask", state.Ask);
            NullableN(sb, "last", state.Last);
            I(sb, "bid_size", state.BidSize);
            I(sb, "ask_size", state.AskSize);
            I(sb, "trade_count_1s", trades1);
            I(sb, "volume_1s", total1);
            I(sb, "buy_volume_1s", buy1);
            I(sb, "sell_volume_1s", sell1);
            I(sb, "delta_1s", delta1);
            I(sb, "delta_5s", delta5);
            I(sb, "cumulative_delta", state.CumulativeDelta);
            I(sb, "book_bid_volume", state.BookBidVolume);
            I(sb, "book_ask_volume", state.BookAskVolume);
            N(sb, "book_imbalance", bookImbalance);
            NullableN(sb, "microprice", microprice);
            NullableN(sb, "spread_ticks", spreadTicks);
            NullableN(sb, "session_vwap", sessionVwap);
            J(sb, "absorption_side", absorptionSide);
            N(sb, "absorption_score", absorptionScore);
            N(sb, "flow_score", flowScore);
            I(sb, "large_trade_count_1s", large1);
            N(sb, "event_age_ms", eventAgeMs);
            N(sb, "engine_us", engineUs);
            sb.Append('}');
            return sb.ToString();
        }

        private void StopFeed()
        {
            try
            {
                if (snapshotTimer != null)
                {
                    snapshotTimer.Dispose();
                    snapshotTimer = null;
                }
                foreach (InstrumentState state in states.Values)
                {
                    if (state.Instrument != null && state.Subscribed && !state.Instrument.Dispatcher.HasShutdownStarted)
                    {
                        InstrumentState captured = state;
                        captured.Instrument.Dispatcher.InvokeAsync(() =>
                        {
                            try { captured.Instrument.MarketData.Update -= OnMarketData; } catch { }
                            try { captured.Instrument.MarketDepth.Update -= OnMarketDepth; } catch { }
                            captured.Subscribed = false;
                        });
                    }
                }
                states.Clear();
                if (udp != null)
                {
                    udp.Close();
                    udp = null;
                }
                lock (outputGate)
                {
                    if (auditWriter != null)
                    {
                        try { auditWriter.Flush(); } catch { }
                        try { auditWriter.Dispose(); } catch { }
                        auditWriter = null;
                    }
                }
            }
            catch { }
        }

        private void Log(string message)
        {
            try { NinjaTrader.Code.Output.Process(Name + ": " + message, PrintTo.OutputTab1); } catch { }
        }

        private static string SessionKey(DateTime utc)
        {
            TimeZoneInfo central = TimeZoneInfo.FindSystemTimeZoneById("Central Standard Time");
            DateTime local = TimeZoneInfo.ConvertTimeFromUtc(utc, central);
            DateTime tradingDate = local.Hour >= 17 ? local.Date.AddDays(1) : local.Date;
            return tradingDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }

        private static long UnixMs(DateTime utc)
        {
            return Convert.ToInt64((utc.ToUniversalTime() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds);
        }

        private static double Clamp(double value, double low, double high)
        {
            return value < low ? low : (value > high ? high : value);
        }

        private static string Iso(DateTime value) { return value.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture); }
        private static string Escape(string value) { return value == null ? null : value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n"); }
        private static void Sep(StringBuilder sb) { if (sb.Length > 1 && sb[sb.Length - 1] != '{') sb.Append(','); }
        private static void J(StringBuilder sb, string key, string value) { Sep(sb); sb.Append('"').Append(key).Append("\":"); if (value == null) sb.Append("null"); else sb.Append('"').Append(Escape(value)).Append('"'); }
        private static void I(StringBuilder sb, string key, long value) { Sep(sb); sb.Append('"').Append(key).Append("\":").Append(value.ToString(CultureInfo.InvariantCulture)); }
        private static void N(StringBuilder sb, string key, double value) { Sep(sb); sb.Append('"').Append(key).Append("\":"); if (Double.IsNaN(value) || Double.IsInfinity(value)) sb.Append("null"); else sb.Append(value.ToString("R", CultureInfo.InvariantCulture)); }
        private static void NullableN(StringBuilder sb, string key, double value) { N(sb, key, value); }

        private sealed class InstrumentState
        {
            public readonly object Sync = new object();
            public readonly string Symbol;
            public readonly string Contract;
            public readonly Instrument Instrument;
            public readonly double TickSize;
            public readonly int LargeTradeThreshold;
            public readonly long[] BucketIds;
            public readonly long[] Buy;
            public readonly long[] Sell;
            public readonly long[] Total;
            public readonly long[] Trades;
            public readonly long[] LargeTrades;
            public readonly double[] FirstPrice;
            public readonly double[] LastPrice;
            public bool Subscribed;
            public double Bid = Double.NaN;
            public double Ask = Double.NaN;
            public double Last = Double.NaN;
            public long BidSize;
            public long AskSize;
            public long LastSize;
            public long BookBidVolume;
            public long BookAskVolume;
            public long CumulativeDelta;
            public long SessionVolume;
            public double PriceVolume;
            public int LastAggressor;
            public DateTime LastEventUtc = DateTime.MinValue;
            public DateTime LastDepthUtc = DateTime.MinValue;
            public DateTime ProviderEventUtc = DateTime.MinValue;
            public string SessionKey = String.Empty;
            public long FirstPriceBucket = Int64.MaxValue;

            public InstrumentState(string symbol, string contract, Instrument instrument, double tickSize, int largeTradeThreshold, int bucketCount)
            {
                Symbol = symbol;
                Contract = contract;
                Instrument = instrument;
                TickSize = tickSize;
                LargeTradeThreshold = largeTradeThreshold;
                BucketIds = new long[bucketCount];
                Buy = new long[bucketCount];
                Sell = new long[bucketCount];
                Total = new long[bucketCount];
                Trades = new long[bucketCount];
                LargeTrades = new long[bucketCount];
                FirstPrice = new double[bucketCount];
                LastPrice = new double[bucketCount];
                for (int i = 0; i < bucketCount; i++)
                {
                    BucketIds[i] = -1;
                    FirstPrice[i] = Double.NaN;
                    LastPrice[i] = Double.NaN;
                }
            }

            public void ResetSession(string key)
            {
                SessionKey = key;
                CumulativeDelta = 0;
                SessionVolume = 0;
                PriceVolume = 0.0;
                for (int i = 0; i < BucketIds.Length; i++)
                {
                    BucketIds[i] = -1;
                    Buy[i] = Sell[i] = Total[i] = Trades[i] = LargeTrades[i] = 0;
                    FirstPrice[i] = LastPrice[i] = Double.NaN;
                }
            }
        }
    }
}
