// Side-by-side Predictive Live V1 feed. Proposed only; do not install before approval.
// Emits completed one-second Level-1 summaries. It never places or manages orders.
#region Using declarations
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    public class TradyticsPredictiveLevel1Feed : AddOnBase
    {
        private const int UdpPort = 48638;
        private readonly Dictionary<string, FeedState> states = new Dictionary<string, FeedState>(StringComparer.OrdinalIgnoreCase);
        private UdpClient udp;
        private Timer timer;
        private long sequence;

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults) { Name = "TradyticsPredictiveLevel1Feed"; Description = "Completed-second ES/NQ Level-1 feed; no orders."; }
            else if (State == State.Active) StartFeed();
            else if (State == State.Terminated) StopFeed();
        }

        private void StartFeed()
        {
            udp = new UdpClient(); udp.Client.SendTimeout = 1; udp.Connect("127.0.0.1", UdpPort);
            Add("ES", Environment.GetEnvironmentVariable("TRADYTICS_ES_CONTRACT") ?? "ES 09-26", 50);
            Add("NQ", Environment.GetEnvironmentVariable("TRADYTICS_NQ_CONTRACT") ?? "NQ 09-26", 50);
            timer = new Timer(Flush, null, 100, 100);
        }

        private void Add(string symbol, string contract, int largeThreshold)
        {
            Instrument instrument = Instrument.GetInstrument(contract);
            if (instrument == null) throw new InvalidOperationException("Cannot resolve " + contract);
            var value = new FeedState(symbol, contract, instrument, largeThreshold); states[contract] = value;
            instrument.Dispatcher.InvokeAsync(() => { instrument.MarketData.Update += OnMarketData; value.Subscribed = true; });
        }

        private void OnMarketData(object sender, MarketDataEventArgs e)
        {
            if (e == null || e.Instrument == null) return;
            FeedState value; if (!states.TryGetValue(e.Instrument.FullName, out value)) return;
            long second = new DateTimeOffset(e.Time.ToUniversalTime()).ToUnixTimeSeconds();
            lock (value.Sync)
            {
                if (value.Second < 0) value.Second = second;
                if (second > value.Second) PublishCompleted(value);
                value.LastProviderEventSecond = second;
                if (e.MarketDataType == MarketDataType.Bid) { value.Bid = e.Price; value.QuoteSeen = true; }
                else if (e.MarketDataType == MarketDataType.Ask) { value.Ask = e.Price; value.QuoteSeen = true; }
                else if (e.MarketDataType == MarketDataType.Last)
                {
                    if (!value.TradeSeen) { value.Open = value.High = value.Low = e.Price; }
                    value.High = Math.Max(value.High, e.Price); value.Low = Math.Min(value.Low, e.Price); value.Close = e.Price;
                    value.Volume += Math.Max(0, e.Volume); value.Trades++; if (e.Volume >= value.LargeThreshold) value.LargeTrades++;
                    value.TradeSeen = true;
                }
            }
        }

        private void Flush(object ignored)
        {
            long completed = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 1;
            foreach (FeedState value in states.Values) lock (value.Sync) if (value.Second >= 0 && value.Second <= completed) PublishCompleted(value);
        }

        private void PublishCompleted(FeedState v)
        {
            long seq = Interlocked.Increment(ref sequence);
            string json = "{\"type\":\"predictive_level1_second_v1\",\"sequence\":" + seq +
                ",\"instrument\":\"" + v.Symbol + "\",\"contract\":\"" + v.Contract + "\",\"second\":" + v.Second +
                ",\"last_open\":" + JsonNumber(v.Open) + ",\"last_high\":" + JsonNumber(v.High) +
                ",\"last_low\":" + JsonNumber(v.Low) + ",\"last_close\":" + JsonNumber(v.Close) +
                ",\"bid\":" + JsonNumber(v.Bid) + ",\"ask\":" + JsonNumber(v.Ask) +
                ",\"volume\":" + v.Volume + ",\"trade_count\":" + v.Trades +
                ",\"large_trade_count\":" + v.LargeTrades +
                ",\"trade_seen\":" + (v.TradeSeen ? "true" : "false") +
                ",\"quote_seen\":" + (v.QuoteSeen ? "true" : "false") +
                ",\"provider_event_second\":" + v.LastProviderEventSecond + "}";
            byte[] bytes = Encoding.UTF8.GetBytes(json); try { udp.Send(bytes, bytes.Length); } catch { }
            v.Second++; v.Open = v.High = v.Low = v.Close = Double.NaN; v.Volume = v.Trades = v.LargeTrades = 0; v.TradeSeen = v.QuoteSeen = false;
        }

        private static string JsonNumber(double value)
        {
            return (Double.IsNaN(value) || Double.IsInfinity(value)) ? "null" : value.ToString("R", CultureInfo.InvariantCulture);
        }

        private void StopFeed()
        {
            if (timer != null) { timer.Dispose(); timer = null; }
            foreach (FeedState value in states.Values) if (value.Subscribed) value.Instrument.MarketData.Update -= OnMarketData;
            states.Clear(); if (udp != null) { udp.Dispose(); udp = null; }
        }

        private sealed class FeedState
        {
            public readonly object Sync = new object(); public readonly string Symbol, Contract; public readonly Instrument Instrument; public readonly int LargeThreshold;
            public bool Subscribed, TradeSeen, QuoteSeen; public long Second = -1, LastProviderEventSecond = -1, Volume, Trades, LargeTrades;
            public double Open = Double.NaN, High = Double.NaN, Low = Double.NaN, Close = Double.NaN, Bid = Double.NaN, Ask = Double.NaN;
            public FeedState(string symbol, string contract, Instrument instrument, int large) { Symbol = symbol; Contract = contract; Instrument = instrument; LargeThreshold = large; }
        }
    }
}
