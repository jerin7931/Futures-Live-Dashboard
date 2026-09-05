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
        private const string V2SourceVersion = "TRADYTICS_OPTIONS_ORDERFLOW_NT_2_0_0";
        private const string DefaultEsContract = "ES 09-26";
        private const string DefaultNqContract = "NQ 09-26";
        private const int SnapshotMs = 100;
        private const int BucketMs = 100;
        private const int BucketCount = 64;
        private const int V1UdpPort = 48636;
        private const int V2UdpPort = 48637;
        private const double FastHalfLifeSeconds = 0.75;
        private const double SlowHalfLifeSeconds = 3.0;
        private const double BookHalfLifeSeconds = 0.5;
        private const double ActiveFlowThreshold = 0.15;

        private readonly Dictionary<string, InstrumentState> states = new Dictionary<string, InstrumentState>(StringComparer.OrdinalIgnoreCase);
        private readonly object outputGate = new object();
        private UdpClient udpV1;
        private UdpClient udpV2;
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
                auditWriter = new StreamWriter(new FileStream(auditPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite, 65536), new UTF8Encoding(false), 65536);
                auditWriter.AutoFlush = false;

                udpV1 = new UdpClient();
                udpV1.Client.SendTimeout = 1;
                udpV1.Connect("127.0.0.1", V1UdpPort);
                udpV2 = new UdpClient();
                udpV2.Client.SendTimeout = 1;
                udpV2.Connect("127.0.0.1", V2UdpPort);

                string esContract = Environment.GetEnvironmentVariable("TRADYTICS_ES_CONTRACT");
                string nqContract = Environment.GetEnvironmentVariable("TRADYTICS_NQ_CONTRACT");
                if (String.IsNullOrWhiteSpace(esContract)) esContract = DefaultEsContract;
                if (String.IsNullOrWhiteSpace(nqContract)) nqContract = DefaultNqContract;
                AddInstrument("ES", esContract, 0.25, 20);
                AddInstrument("NQ", nqContract, 0.25, 10);
                snapshotTimer = new Timer(PublishSnapshots, null, SnapshotMs, SnapshotMs);
                Log("active; V1 UDP " + V1UdpPort.ToString(CultureInfo.InvariantCulture)
                    + ", V2 shadow UDP " + V2UdpPort.ToString(CultureInfo.InvariantCulture)
                    + "; contracts " + esContract + " / " + nqContract);
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
                state.PendingBuy += size;
                state.AskExecuted += size;
                state.AskHitPrice = ask;
            }
            else if (side < 0)
            {
                state.Sell[index] += size;
                state.CumulativeDelta -= size;
                state.PendingSell += size;
                state.BidExecuted += size;
                state.BidHitPrice = bid;
            }
            state.Total[index] += size;
            state.Trades[index] += 1;
            if (size >= state.LargeTradeThreshold)
            {
                state.LargeTrades[index] += 1;
                if (side > 0) state.PendingLargeBuy += size;
                else if (side < 0) state.PendingLargeSell += size;
            }
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
                    var nextBids = new Dictionary<double, long>();
                    var nextAsks = new Dictionary<double, long>();
                    for (int i = 0; i < 5; i++)
                    {
                        state.BidDepthPrices[i] = Double.NaN;
                        state.AskDepthPrices[i] = Double.NaN;
                        state.BidDepthSizes[i] = 0;
                        state.AskDepthSizes[i] = 0;
                    }
                    for (int i = 0; i < bidCount; i++)
                    {
                        double price = state.Instrument.MarketDepth.Bids[i].Price;
                        long size = Math.Max(0L, state.Instrument.MarketDepth.Bids[i].Volume);
                        state.BookBidVolume += size;
                        state.BidDepthPrices[i] = price;
                        state.BidDepthSizes[i] = size;
                        nextBids[price] = size;
                        long prior;
                        if (!Double.IsNaN(state.BidHitPrice) && Math.Abs(price - state.BidHitPrice) <= state.TickSize * 0.1
                            && state.PreviousBidDepth.TryGetValue(price, out prior) && size > prior)
                            state.BidReadded += size - prior;
                    }
                    for (int i = 0; i < askCount; i++)
                    {
                        double price = state.Instrument.MarketDepth.Asks[i].Price;
                        long size = Math.Max(0L, state.Instrument.MarketDepth.Asks[i].Volume);
                        state.BookAskVolume += size;
                        state.AskDepthPrices[i] = price;
                        state.AskDepthSizes[i] = size;
                        nextAsks[price] = size;
                        long prior;
                        if (!Double.IsNaN(state.AskHitPrice) && Math.Abs(price - state.AskHitPrice) <= state.TickSize * 0.1
                            && state.PreviousAskDepth.TryGetValue(price, out prior) && size > prior)
                            state.AskReadded += size - prior;
                    }
                    state.PreviousBidDepth = nextBids;
                    state.PreviousAskDepth = nextAsks;
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
                    long snapshotSequence = Interlocked.Increment(ref sequence);
                    string v1Line;
                    string v2Line;
                    lock (state.Sync)
                    {
                        v1Line = BuildV1Snapshot(state, nowMs, started, snapshotSequence);
                        v2Line = BuildV2Snapshot(state, nowMs, started, snapshotSequence);
                    }
                    byte[] v1Bytes = Encoding.UTF8.GetBytes(v1Line);
                    byte[] v2Bytes = Encoding.UTF8.GetBytes(v2Line);
                    try
                    {
                        if (udpV1 != null)
                            udpV1.Send(v1Bytes, v1Bytes.Length);
                        if (udpV2 != null)
                            udpV2.Send(v2Bytes, v2Bytes.Length);
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
                                auditWriter.WriteLine(v2Line);
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

        private string BuildV1Snapshot(InstrumentState state, long nowMs, long startedTicks, long snapshotSequence)
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
            I(sb, "sequence", snapshotSequence);
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

        private string BuildV2Snapshot(InstrumentState state, long nowMs, long startedTicks, long snapshotSequence)
        {
            long nowTicks = Stopwatch.GetTimestamp();
            double dt = state.LastFeatureTicks == 0
                ? SnapshotMs / 1000.0
                : Math.Max(0.001, (nowTicks - state.LastFeatureTicks) / (double)Stopwatch.Frequency);
            state.LastFeatureTicks = nowTicks;

            long buy = state.PendingBuy;
            long sell = state.PendingSell;
            long total = buy + sell;
            long signed = buy - sell;
            double fastAlpha = DecayAlpha(dt, FastHalfLifeSeconds);
            double slowAlpha = DecayAlpha(dt, SlowHalfLifeSeconds);
            state.FastNumerator = (1.0 - fastAlpha) * state.FastNumerator + fastAlpha * signed;
            state.FastDenominator = (1.0 - fastAlpha) * state.FastDenominator + fastAlpha * total;
            state.SlowNumerator = (1.0 - slowAlpha) * state.SlowNumerator + slowAlpha * signed;
            state.SlowDenominator = (1.0 - slowAlpha) * state.SlowDenominator + slowAlpha * total;
            double fFast = state.FastDenominator > 1e-12 ? Clamp(state.FastNumerator / state.FastDenominator, -1.0, 1.0) : 0.0;
            double fSlow = state.SlowDenominator > 1e-12 ? Clamp(state.SlowNumerator / state.SlowDenominator, -1.0, 1.0) : 0.0;
            double aggression = Clamp(0.60 * fFast + 0.40 * fSlow, -1.0, 1.0);

            double weightedBid = 0.0, weightedAsk = 0.0;
            for (int i = 0; i < 5; i++)
            {
                weightedBid += Math.Max(0L, state.BidDepthSizes[i]) / (i + 1.0);
                weightedAsk += Math.Max(0L, state.AskDepthSizes[i]) / (i + 1.0);
            }
            double depthTotal = weightedBid + weightedAsk;
            double rawDepth = depthTotal > 1e-12 ? Clamp((weightedBid - weightedAsk) / depthTotal, -1.0, 1.0) : 0.0;
            double bookAlpha = DecayAlpha(dt, BookHalfLifeSeconds);
            state.SmoothedDepth = (1.0 - bookAlpha) * state.SmoothedDepth + bookAlpha * rawDepth;

            bool validTop = state.Bid > 0 && state.Ask >= state.Bid && state.BidSize > 0 && state.AskSize > 0;
            double microprice = validTop
                ? (state.Ask * state.BidSize + state.Bid * state.AskSize) / (state.BidSize + state.AskSize)
                : Double.NaN;
            double mid = validTop ? (state.Bid + state.Ask) / 2.0 : Double.NaN;
            double micropriceEdge = validTop
                ? Clamp(2.0 * (microprice - mid) / Math.Max(state.Ask - state.Bid, 1e-12), -1.0, 1.0)
                : 0.0;
            double book = validTop
                ? Clamp(0.50 * state.SmoothedDepth + 0.50 * micropriceEdge, -1.0, 1.0)
                : (depthTotal > 0 ? Clamp(0.50 * state.SmoothedDepth, -1.0, 1.0) : 0.0);

            long largeBuy = state.PendingLargeBuy;
            long largeSell = state.PendingLargeSell;
            long largeTotal = largeBuy + largeSell;
            long largeSigned = largeBuy - largeSell;
            state.LargeNumerator = (1.0 - fastAlpha) * state.LargeNumerator + fastAlpha * largeSigned;
            state.LargeDenominator = (1.0 - fastAlpha) * state.LargeDenominator + fastAlpha * largeTotal;
            double largeDirection = state.LargeDenominator > 1e-12
                ? Clamp(state.LargeNumerator / state.LargeDenominator, -1.0, 1.0)
                : 0.0;

            double priceTicks = !Double.IsNaN(state.Last) && !Double.IsNaN(state.LastSnapshotPrice)
                ? (state.Last - state.LastSnapshotPrice) / state.TickSize
                : 0.0;
            double normalizedResponse = Clamp(Math.Tanh(priceTicks / 2.0), -1.0, 1.0);
            if (!Double.IsNaN(state.Last)) state.LastSnapshotPrice = state.Last;
            double activityFloor = state.Symbol == "ES" ? 50.0 : 30.0;
            double activity = Clamp(total / activityFloor, 0.0, 1.0);
            double askReplenishment = state.AskExecuted > 0
                ? Clamp(state.AskReadded / (double)state.AskExecuted, 0.0, 1.0)
                : 0.0;
            double bidReplenishment = state.BidExecuted > 0
                ? Clamp(state.BidReadded / (double)state.BidExecuted, 0.0, 1.0)
                : 0.0;
            double responseMagnitude = Clamp(Math.Abs(normalizedResponse), 0.0, 1.0);
            double sellAbsorption = Math.Max(fFast, 0.0) * activity * (1.0 - responseMagnitude) * askReplenishment;
            double buyAbsorption = Math.Max(-fFast, 0.0) * activity * (1.0 - responseMagnitude) * bidReplenishment;
            double absorption = Clamp(buyAbsorption - sellAbsorption, -1.0, 1.0);
            double executionResponse = Clamp(0.40 * largeDirection + 0.35 * absorption + 0.25 * normalizedResponse, -1.0, 1.0);
            double flowEvidence = Median3(aggression, book, executionResponse);

            bool active = total > 0 && Math.Abs(flowEvidence) >= ActiveFlowThreshold;
            int flowSign = flowEvidence > 0 ? 1 : (flowEvidence < 0 ? -1 : 0);
            long sampleId = nowMs / BucketMs;
            int sampleIndex = (int)(sampleId % state.FlowSampleIds.Length);
            state.FlowSampleIds[sampleIndex] = sampleId;
            state.FlowSampleSigns[sampleIndex] = flowSign;
            state.FlowSampleActive[sampleIndex] = active;
            int availableSamples = 0, activeSamples = 0, agreeingSamples = 0;
            for (int i = 0; i < state.FlowSampleIds.Length; i++)
            {
                long age = sampleId - state.FlowSampleIds[i];
                if (age < 0 || age >= 20) continue;
                availableSamples++;
                if (!state.FlowSampleActive[i]) continue;
                activeSamples++;
                if (flowSign != 0 && state.FlowSampleSigns[i] == flowSign) agreeingSamples++;
            }
            double persistence = activeSamples > 0 && flowSign != 0 ? agreeingSamples / (double)activeSamples : 0.0;
            double activeFraction = availableSamples > 0 ? activeSamples / (double)availableSamples : 0.0;
            if (!active)
            {
                state.LastFlowSign = 0;
                state.FlowSignSinceTicks = nowTicks;
            }
            else if (state.LastFlowSign != flowSign)
            {
                state.LastFlowSign = flowSign;
                state.FlowSignSinceTicks = nowTicks;
            }
            double signDuration = active && state.FlowSignSinceTicks > 0
                ? Math.Max(0.0, (nowTicks - state.FlowSignSinceTicks) / (double)Stopwatch.Frequency)
                : 0.0;

            double engineUs = (Stopwatch.GetTimestamp() - startedTicks) * 1000000.0 / Stopwatch.Frequency;
            double eventAgeMs = state.LastEventUtc == DateTime.MinValue ? Double.NaN : Math.Max(0.0, (DateTime.UtcNow - state.LastEventUtc).TotalMilliseconds);
            double depthAgeMs = state.LastDepthUtc == DateTime.MinValue ? Double.NaN : Math.Max(0.0, (DateTime.UtcNow - state.LastDepthUtc).TotalMilliseconds);
            var sb = new StringBuilder(2048);
            sb.Append('{');
            J(sb, "type", "options_orderflow_snapshot_v2");
            J(sb, "source_version", V2SourceVersion);
            I(sb, "sequence", snapshotSequence);
            J(sb, "symbol", state.Symbol);
            J(sb, "contract", state.Contract);
            J(sb, "rollover_status", "CONFIGURED_EXPLICIT");
            J(sb, "provider_event_time", Iso(state.ProviderEventUtc == DateTime.MinValue ? DateTime.UtcNow : state.ProviderEventUtc));
            J(sb, "local_receive_time", Iso(state.LastEventUtc == DateTime.MinValue ? DateTime.UtcNow : state.LastEventUtc));
            J(sb, "feature_complete_time", Iso(DateTime.UtcNow));
            NullableN(sb, "bid", state.Bid);
            NullableN(sb, "ask", state.Ask);
            NullableN(sb, "last", state.Last);
            I(sb, "bid_size", state.BidSize);
            I(sb, "ask_size", state.AskSize);
            I(sb, "bucket_buy_volume", buy);
            I(sb, "bucket_sell_volume", sell);
            I(sb, "bucket_total_volume", total);
            N(sb, "f_fast", fFast);
            N(sb, "f_slow", fSlow);
            N(sb, "aggression", aggression);
            N(sb, "depth_imbalance", state.SmoothedDepth);
            NullableN(sb, "microprice", microprice);
            N(sb, "microprice_edge", micropriceEdge);
            N(sb, "book", book);
            N(sb, "large_trade_direction", largeDirection);
            N(sb, "bid_replenishment", bidReplenishment);
            N(sb, "ask_replenishment", askReplenishment);
            N(sb, "absorption", absorption);
            N(sb, "normalized_price_response", normalizedResponse);
            N(sb, "execution_response", executionResponse);
            N(sb, "futures_flow_evidence", flowEvidence);
            N(sb, "flow_persistence", persistence);
            N(sb, "flow_active_fraction", activeFraction);
            N(sb, "flow_sign_duration", signDuration);
            NullableN(sb, "session_vwap", state.SessionVolume > 0 ? state.PriceVolume / state.SessionVolume : Double.NaN);
            N(sb, "event_age_ms", eventAgeMs);
            N(sb, "depth_age_ms", depthAgeMs);
            N(sb, "engine_us", engineUs);
            sb.Append('}');

            state.PendingBuy = state.PendingSell = 0;
            state.PendingLargeBuy = state.PendingLargeSell = 0;
            state.BidExecuted = state.AskExecuted = 0;
            state.BidReadded = state.AskReadded = 0;
            state.BidHitPrice = state.AskHitPrice = Double.NaN;
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
                if (udpV1 != null)
                {
                    udpV1.Close();
                    udpV1 = null;
                }
                if (udpV2 != null)
                {
                    udpV2.Close();
                    udpV2 = null;
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

        private static double DecayAlpha(double dtSeconds, double halfLifeSeconds)
        {
            return Clamp(1.0 - Math.Exp(-Math.Log(2.0) * Math.Max(dtSeconds, 0.0) / halfLifeSeconds), 0.0, 1.0);
        }

        private static double Median3(double a, double b, double c)
        {
            if (a > b) { double t = a; a = b; b = t; }
            if (b > c) { double t = b; b = c; c = t; }
            if (a > b) { double t = a; a = b; b = t; }
            return Clamp(b, -1.0, 1.0);
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
            public readonly double[] BidDepthPrices = new double[5];
            public readonly double[] AskDepthPrices = new double[5];
            public readonly long[] BidDepthSizes = new long[5];
            public readonly long[] AskDepthSizes = new long[5];
            public Dictionary<double, long> PreviousBidDepth = new Dictionary<double, long>();
            public Dictionary<double, long> PreviousAskDepth = new Dictionary<double, long>();
            public long CumulativeDelta;
            public long SessionVolume;
            public double PriceVolume;
            public int LastAggressor;
            public DateTime LastEventUtc = DateTime.MinValue;
            public DateTime LastDepthUtc = DateTime.MinValue;
            public DateTime ProviderEventUtc = DateTime.MinValue;
            public string SessionKey = String.Empty;
            public long FirstPriceBucket = Int64.MaxValue;
            public long PendingBuy;
            public long PendingSell;
            public long PendingLargeBuy;
            public long PendingLargeSell;
            public long BidExecuted;
            public long AskExecuted;
            public long BidReadded;
            public long AskReadded;
            public double BidHitPrice = Double.NaN;
            public double AskHitPrice = Double.NaN;
            public double FastNumerator;
            public double FastDenominator;
            public double SlowNumerator;
            public double SlowDenominator;
            public double LargeNumerator;
            public double LargeDenominator;
            public double SmoothedDepth;
            public double LastSnapshotPrice = Double.NaN;
            public long LastFeatureTicks;
            public readonly long[] FlowSampleIds = new long[32];
            public readonly int[] FlowSampleSigns = new int[32];
            public readonly bool[] FlowSampleActive = new bool[32];
            public int LastFlowSign;
            public long FlowSignSinceTicks;

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
                for (int i = 0; i < 5; i++)
                {
                    BidDepthPrices[i] = Double.NaN;
                    AskDepthPrices[i] = Double.NaN;
                }
                for (int i = 0; i < FlowSampleIds.Length; i++)
                    FlowSampleIds[i] = -1;
            }

            public void ResetSession(string key)
            {
                SessionKey = key;
                CumulativeDelta = 0;
                SessionVolume = 0;
                PriceVolume = 0.0;
                PendingBuy = PendingSell = PendingLargeBuy = PendingLargeSell = 0;
                BidExecuted = AskExecuted = BidReadded = AskReadded = 0;
                BidHitPrice = AskHitPrice = Double.NaN;
                FastNumerator = FastDenominator = SlowNumerator = SlowDenominator = 0.0;
                LargeNumerator = LargeDenominator = SmoothedDepth = 0.0;
                LastSnapshotPrice = Double.NaN;
                LastFeatureTicks = 0;
                LastFlowSign = 0;
                FlowSignSinceTicks = 0;
                PreviousBidDepth.Clear();
                PreviousAskDepth.Clear();
                for (int i = 0; i < FlowSampleIds.Length; i++)
                {
                    FlowSampleIds[i] = -1;
                    FlowSampleSigns[i] = 0;
                    FlowSampleActive[i] = false;
                }
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
