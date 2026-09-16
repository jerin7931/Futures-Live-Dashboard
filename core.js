const CT_ZONE = "America/Chicago";

export function asDate(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function ageSeconds(value, now = new Date()) {
  const parsed = asDate(value);
  return parsed ? Math.max(0, (now.getTime() - parsed.getTime()) / 1000) : null;
}

export function ageLabel(value, now = new Date()) {
  const seconds = ageSeconds(value, now);
  if (seconds === null) return "unavailable";
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
}

export function analysisIsStale(row, now = new Date()) {
  const validUntil = asDate(row?.valid_until);
  return !validUntil || validUntil.getTime() < now.getTime();
}

export function healthState({ timestamp, closed = false, thresholdSeconds, now = new Date() }) {
  if (closed) return "MARKET CLOSED";
  const age = ageSeconds(timestamp, now);
  if (age === null) return "UNAVAILABLE";
  return age <= thresholdSeconds ? "LIVE" : "STALE";
}

export function statusClass(value) {
  const normalized = String(value || "").toUpperCase();
  if (["LIVE", "CONFIRMED", "BULLISH", "TARGET REACHED", "FRESH"].includes(normalized)) return "positive";
  if (["STALE", "INVALIDATED", "BEARISH", "DELAYED", "UNAVAILABLE"].includes(normalized)) return "negative";
  if (["FORMING", "WAIT", "TRANSITION"].includes(normalized)) return "warning";
  return "neutral";
}

export function number(value, digits = 2) {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US", { maximumFractionDigits: digits }) : "—";
}

export function dateTime(value) {
  const parsed = asDate(value);
  if (!parsed) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(parsed);
}

export function timeOnly(value) {
  const parsed = asDate(value);
  if (!parsed) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
}

export function ctClock(now = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(now);
}

export function isMeaningfulHistory(row) {
  const changed = String(row?.payload?.changed || row?.changed || "").toLowerCase();
  if (!changed) return false;
  return !changed.includes("unchanged") &&
    !changed.includes("same setup") &&
    !changed.includes("no new analysis") &&
    !changed.includes("prior state was preserved");
}

export function keyLevels(context, price) {
  const candidates = [
    ["PDH", context?.prior_day_high],
    ["PDL", context?.prior_day_low],
    ["Premarket High", context?.premarket_high],
    ["Premarket Low", context?.premarket_low],
    ["Opening Range High", context?.opening_range_high],
    ["Opening Range Low", context?.opening_range_low],
  ];
  const current = Number(price);
  const swings = Array.isArray(context?.important_15m_levels) ? context.important_15m_levels : [];
  const nearest = (type) => swings
    .filter((level) => level?.type === type && Number.isFinite(Number(level?.price)))
    .sort((a, b) => Math.abs(Number(a.price) - current) - Math.abs(Number(b.price) - current))[0];
  const resistance = nearest("SWING_HIGH");
  const support = nearest("SWING_LOW");
  if (resistance) candidates.push(["15m Resistance", resistance.price]);
  if (support) candidates.push(["15m Support", support.price]);
  return candidates.filter(([, value]) => value !== null && value !== undefined && value !== "");
}

export function levelInteraction(location, levelType) {
  const typeMap = {
    PDH: "PDH", PDL: "PDL",
    "Premarket High": "PREMARKET_HIGH", "Premarket Low": "PREMARKET_LOW",
    "Opening Range High": "OPENING_RANGE_HIGH", "Opening Range Low": "OPENING_RANGE_LOW",
    "15m Resistance": "SWING_HIGH", "15m Support": "SWING_LOW",
  };
  if (!location?.active_level || location.active_level.type !== typeMap[levelType]) return null;
  const state = String(location.active_level.relation || "").toUpperCase();
  return ["AT", "ABOVE", "BELOW", "RECLAIMING", "REJECTING"].includes(state) ? state : null;
}

export function footprintContext(context) {
  const summary = String(context?.location_summary || "").trim();
  return summary && summary.toLowerCase() !== "context unavailable" ? summary : null;
}

export function nextExpectedLabel(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: CT_ZONE,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  if (weekday >= 1 && weekday <= 5 && minuteOfDay < 8 * 60 + 31) return "Today · 08:31 CT";
  if (weekday >= 1 && weekday <= 5 && minuteOfDay <= 15 * 60 + 1) {
    const elapsed = minuteOfDay - (8 * 60 + 31);
    const next = 8 * 60 + 31 + Math.ceil(Math.max(1, elapsed) / 5) * 5;
    if (next <= 15 * 60 + 1) return `Today · ${String(Math.floor(next / 60)).padStart(2, "0")}:${String(next % 60).padStart(2, "0")} CT`;
  }
  let days = 1;
  let nextDay = (weekday + days) % 7;
  while (nextDay === 0 || nextDay === 6) {
    days += 1;
    nextDay = (weekday + days) % 7;
  }
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `${days === 1 ? "Tomorrow" : names[nextDay]} · 08:31 CT`;
}
