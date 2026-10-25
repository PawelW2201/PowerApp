// calendar.js — delivery hours of standard power products.
// A port of PowerDesk's powerdesk/products.py (the reference implementation);
// tests/calendar.test.mjs checks the two agree on a fixture made from the Python side.
// Hours are real elapsed hours in the market's time zone, so clock-change days
// have 23 or 25 hours. No dependencies: time zones come from the browser's Intl data.

const DAY_MS = 86400000;
export const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = Object.fromEntries(MONTH_ABBR.map((m, i) => [m.toLowerCase(), i + 1]));
export const PROFILES = ["base", "peak", "offpeak"];

// ------------------------------------------------------------------ markets
const EEX_PEAK = { start: 8, end: 20, weekdays: [0, 1, 2, 3, 4], holidays: null, name: "Peak Mon-Fri 08-20" };
const TGE_PEAK5 = { start: 7, end: 22, weekdays: [0, 1, 2, 3, 4], holidays: "PL", name: "PEAK5 working days 07-22" };

export const MARKETS = Object.fromEntries([
  ["DE", "Germany-Luxembourg", "Europe/Berlin"], ["AT", "Austria", "Europe/Vienna"],
  ["CH", "Switzerland", "Europe/Zurich"], ["FR", "France", "Europe/Paris"],
  ["NL", "Netherlands", "Europe/Amsterdam"], ["BE", "Belgium", "Europe/Brussels"],
  ["IT", "Italy", "Europe/Rome"], ["ES", "Spain", "Europe/Madrid"],
  ["CZ", "Czechia", "Europe/Prague"], ["SK", "Slovakia", "Europe/Bratislava"],
  ["HU", "Hungary", "Europe/Budapest"], ["SI", "Slovenia", "Europe/Ljubljana"],
].map(([code, name, tz]) => [code, { code, name, tz, peak: EEX_PEAK, convention: "EEX" }]));
MARKETS.PL = { code: "PL", name: "Poland", tz: "Europe/Warsaw", peak: TGE_PEAK5, convention: "TGE" };

export function getMarket(code) {
  const m = typeof code === "object" ? code : MARKETS[String(code).toUpperCase()];
  if (!m) throw new Error(`unknown market ${code}; known: ${Object.keys(MARKETS).sort().join(", ")}`);
  return m;
}

// ------------------------------------------------------------------ dates as day numbers (days since 1970-01-01)
export const dayNum = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
export function ymd(n) {
  const t = new Date(n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
export const weekday = (n) => (((n + 3) % 7) + 7) % 7; // 0 = Monday (1970-01-01 was a Thursday)
const pad = (x) => String(x).padStart(2, "0");
export const isoDate = (n) => { const { y, m, d } = ymd(n); return `${y}-${pad(m)}-${pad(d)}`; };
export function parseIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`not a date: ${s}`);
  const n = dayNum(+m[1], +m[2], +m[3]);
  if (isoDate(n) !== s) throw new Error(`not a date: ${s}`);
  return n;
}
const yy = (y) => pad(y % 100);
const fmtDb = (n) => { const { m, d } = ymd(n); return `${pad(d)} ${MONTH_ABBR[m - 1]}`; };   // %d %b
const fmtAdb = (n) => `${WD_ABBR[weekday(n)]} ${fmtDb(n)}`;                                  // %a %d %b

// ------------------------------------------------------------------ time zones via Intl
const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    });
    dtfCache.set(tz, f);
  }
  return f;
}
// Local wall-clock parts of a UTC instant (ms).
export function localParts(ms, tz) {
  const p = {};
  for (const { type, value } of dtf(tz).formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
function offsetMs(ms, tz) {
  const p = localParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
// UTC instant (ms) of a local wall-clock time. Unambiguous for the whole hours used here
// (clock changes in these zones happen at 02:00-03:00, never at midnight or in peak).
export function zonedToUtc(n, hour, tz) {
  const { y, m, d } = ymd(n);
  const guess = Date.UTC(y, m - 1, d, hour);
  let t = guess - offsetMs(guess, tz);
  const t2 = guess - offsetMs(t, tz);
  return t2 === t ? t : t2;
}
// Today's date in a time zone, as a day number.
export function todayIn(tz, now = Date.now()) {
  const p = localParts(now, tz);
  return dayNum(p.y, p.m, p.d);
}

// ------------------------------------------------------------------ holidays (only what a definition needs)
export function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const x = h + l - 7 * m + 114;
  return dayNum(year, Math.floor(x / 31), (x % 31) + 1);
}
const holidayCache = new Map();
export function polishHolidays(year) {
  let s = holidayCache.get(year);
  if (s) return s;
  const easter = easterSunday(year);
  s = new Set([
    dayNum(year, 1, 1), easter, easter + 1, dayNum(year, 5, 1), dayNum(year, 5, 3),
    easter + 49, easter + 60, dayNum(year, 8, 15), dayNum(year, 11, 1), dayNum(year, 11, 11),
    dayNum(year, 12, 25), dayNum(year, 12, 26),
  ]);
  if (year >= 2011) s.add(dayNum(year, 1, 6));    // Trzech Króli
  if (year >= 2025) s.add(dayNum(year, 12, 24));  // Wigilia
  holidayCache.set(year, s);
  return s;
}
const CALENDARS = { PL: polishHolidays };
export const isHoliday = (n, cal) => CALENDARS[cal](ymd(n).y).has(n);

// ------------------------------------------------------------------ hours
export function baseHours(n, market) {
  return Math.round((zonedToUtc(n + 1, 0, market.tz) - zonedToUtc(n, 0, market.tz)) / 3600000);
}
export function peakHours(n, market) {
  const r = market.peak;
  if (!r.weekdays.includes(weekday(n))) return 0;
  if (r.holidays && isHoliday(n, r.holidays)) return 0;
  const end = r.end === 24 ? zonedToUtc(n + 1, 0, market.tz) : zonedToUtc(n, r.end, market.tz);
  return Math.round((end - zonedToUtc(n, r.start, market.tz)) / 3600000);
}

export function delivery(product, marketCode = "DE", asof = null) {
  const market = getMarket(marketCode);
  const p = typeof product === "string" ? parse(product, asof ?? todayIn(market.tz)) : product;
  let base = 0, peak = 0;
  for (let n = p.start; n < p.end; n++) { base += baseHours(n, market); peak += peakHours(n, market); }
  return {
    period: p, market,
    startUtc: zonedToUtc(p.start, 0, market.tz), endUtc: zonedToUtc(p.end, 0, market.tz),
    hours: { base, peak, offpeak: base - peak },
  };
}

// ------------------------------------------------------------------ parsing
const year = (s) => { const v = +s; return v < 100 ? 2000 + v : v; };
const period = (kind, label, start, end) => ({ kind, label, start, end, days: end - start, lastDay: end - 1 });

function month(y, m) {
  if (!(m >= 1 && m <= 12)) throw new Error(`there is no month ${m}`);
  return period("Month", `${MONTH_ABBR[m - 1]}-${yy(y)}`, dayNum(y, m, 1), m === 12 ? dayNum(y + 1, 1, 1) : dayNum(y, m + 1, 1));
}
// ISO weeks: week 1 contains 4 January.
export function isoMonday(y, week) {
  const jan4 = dayNum(y, 1, 4);
  const monday1 = jan4 - weekday(jan4);
  const weeks = isoWeekOf(dayNum(y, 12, 28)).week;
  if (!(week >= 1 && week <= weeks)) throw new Error(`${y} has no ISO week ${week}`);
  return monday1 + (week - 1) * 7;
}
export function isoWeekOf(n) {
  const thursday = n - weekday(n) + 3;
  const y = ymd(thursday).y;
  return { year: y, week: Math.floor((thursday - dayNum(y, 1, 1)) / 7) + 1 };
}

export function parse(code, asof) {
  if (asof == null) asof = todayIn("Europe/Berlin");
  const t = String(code).trim().toLowerCase().replace(/[\s_.]+/g, "");
  let m;
  if ((m = /^(?:cal|year|yr|y)-?(\d{2}|\d{4})$/.exec(t))) {
    const y = year(m[1]);
    return period("Year", `Cal-${yy(y)}`, dayNum(y, 1, 1), dayNum(y + 1, 1, 1));
  }
  if ((m = /^q([1-4])-?(\d{2}|\d{4})$/.exec(t))) {
    const q = +m[1], y = year(m[2]);
    return period("Quarter", `Q${q}-${yy(y)}`, dayNum(y, 3 * q - 2, 1), q === 4 ? dayNum(y + 1, 1, 1) : dayNum(y, 3 * q + 1, 1));
  }
  if ((m = /^(sum|summer|win|winter)-?(\d{2}|\d{4})$/.exec(t))) {
    const y = year(m[2]);
    return m[1].startsWith("sum")
      ? period("Season", `Sum-${yy(y)}`, dayNum(y, 4, 1), dayNum(y, 10, 1))
      : period("Season", `Win-${yy(y)}`, dayNum(y, 10, 1), dayNum(y + 1, 4, 1));
  }
  if ((m = /^([a-z]{3})-?(\d{2}|\d{4})$/.exec(t)) && MONTHS[m[1]]) return month(year(m[2]), MONTHS[m[1]]);
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(t))) return month(+m[1], +m[2]);
  if ((m = /^(?:wk|week)(\d{1,2})(?:-(\d{2}|\d{4}))?$/.exec(t))) {
    const week = +m[1];
    let y;
    if (m[2]) y = year(m[2]);
    else {   // the next week with that number that hasn't started yet
      y = isoWeekOf(asof).year;
      try { if (isoMonday(y, week) <= asof) y += 1; } catch { y += 1; }
    }
    const monday = isoMonday(y, week);
    return period("Week", `Wk${pad(week)}-${yy(y)}`, monday, monday + 7);
  }
  if (t === "we" || t === "weekend") {
    const sat = asof + ((5 - weekday(asof) + 7) % 7 || 7), sun = sat + 1;
    const label = ymd(sat).m === ymd(sun).m ? `WE ${pad(ymd(sat).d)}–${fmtDb(sun)}` : `WE ${fmtDb(sat)}–${fmtDb(sun)}`;
    return period("Weekend", label, sat, sun + 1);
  }
  if (t === "bow") {
    const start = asof + 1, end = asof + 7 - weekday(asof);
    if (start >= end) throw new Error(`BOW as of ${isoDate(asof)}: nothing left to deliver this week`);
    return period("BOW", `BOW ${fmtDb(start)}–${fmtDb(end - 1)}`, start, end);
  }
  if (t === "bom") {
    const { y, m: mo } = ymd(asof);
    const start = asof + 1, end = mo === 12 ? dayNum(y + 1, 1, 1) : dayNum(y, mo + 1, 1);
    if (start >= end) throw new Error(`BOM as of ${isoDate(asof)}: nothing left to deliver this month`);
    return period("BOM", `BOM ${pad(ymd(start).d)}–${fmtDb(end - 1)}`, start, end);
  }
  if (t === "da" || t === "d+1" || t === "dayahead" || t === "tomorrow") {
    const n = asof + 1;
    return period("Day", `DA ${fmtAdb(n)}`, n, n + 1);
  }
  if ((m = /^(?:day)?(\d{4}-\d{2}-\d{2})$/.exec(t))) {
    const n = parseIso(m[1]);
    return period("Day", `Day ${fmtAdb(n)} ${yy(ymd(n).y)}`, n, n + 1);
  }
  throw new Error(`can't read product "${code}"; try Cal27, Q1-27, Sum27, Nov26, Wk45, WE, BOW, BOM, DA or 2026-10-25`);
}

// The standard strip a desk quotes, relative to a date: next months, quarters, seasons, years.
export function strip(asof) {
  const { y, m } = ymd(asof);
  const out = [];
  for (let k = 1; k <= 3; k++) { const mm = (m - 1 + k) % 12 + 1, yr = y + Math.floor((m - 1 + k) / 12); out.push(`${MONTH_ABBR[mm - 1]}${yy(yr)}`); }
  const q = Math.floor((m - 1) / 3) + 1;
  for (let k = 1; k <= 4; k++) { const qq = (q - 1 + k) % 4 + 1, yr = y + Math.floor((q - 1 + k) / 4); out.push(`Q${qq}-${yy(yr)}`); }
  const inSummer = m >= 4 && m <= 9;
  out.push(inSummer ? `Win${yy(y)}` : `Sum${yy(m >= 10 ? y + 1 : y)}`);
  out.push(inSummer ? `Sum${yy(y + 1)}` : `Win${yy(m >= 10 ? y + 1 : y)}`);
  for (let k = 1; k <= 3; k++) out.push(`Cal${yy(y + k)}`);
  return out;
}
