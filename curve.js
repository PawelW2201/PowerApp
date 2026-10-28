// curve.js — hourly price forward curve from quotes, and what profiles are worth against it.
// A port of PowerDesk's powerdesk/curve.py (the reference); tests/curve.test.mjs checks the two agree.
//
// 1. Blocks: every month in the quoted horizon gets a peak and an off-peak price. Each quote is an
//    hours-weighted average of them. Unquoted months start from a seasonal prior from history, scaled
//    to the quotes' level; the curve changes the prior as little as possible (relative terms) while
//    repricing the quotes exactly. Finer products first: a coarser quote that contradicts them is
//    left out and reported with the value the others imply.
// 2. Hours: historical shape factors by day type and hour, scaled so each block averages to its price.
// 3. Profiles: blocks of hours, solar and wind capture prices, a battery's one-cycle-a-day value.
import { parse, delivery, getMarket, zonedToUtc, weekday, ymd, dayNum, isHoliday, easterSunday, MONTH_ABBR } from "./calendar.js";

const GRANULARITY = { Month: 1, Quarter: 2, Season: 3, Year: 4 };
export const TOL = 0.005;

// ------------------------------------------------------------------ calendar
const nextMonth = (n) => { const { y, m } = ymd(n); return m === 12 ? dayNum(y + 1, 1, 1) : dayNum(y, m + 1, 1); };
function monthsBetween(start, end) {
  const out = [];
  const { y, m } = ymd(start);
  for (let n = dayNum(y, m, 1); n < end; n = nextMonth(n)) out.push(n);
  return out;
}
const holidayCache = new Map();
function commonHolidays(year) {
  let s = holidayCache.get(year);
  if (!s) {
    const e = easterSunday(year);
    s = new Set([dayNum(year, 1, 1), e + 1, dayNum(year, 5, 1), dayNum(year, 12, 25), dayNum(year, 12, 26)]);
    holidayCache.set(year, s);
  }
  return s;
}
export function daytype(n) {
  const w = weekday(n);
  if (commonHolidays(ymd(n).y).has(n) || w === 6) return 2;
  return w === 5 ? 1 : 0;
}
function isPeak(n, hour, market) {
  const r = market.peak;
  if (!r.weekdays.includes(weekday(n)) || hour < r.start || hour >= r.end) return false;
  return !(r.holidays && isHoliday(n, r.holidays));
}
// [utc seconds, day, local hour, day type, peak] for every hour of the month starting on day n.
export function monthHours(month, market) {
  const out = [];
  for (let n = month, end = nextMonth(month); n < end; n++) {
    const a = zonedToUtc(n, 0, market.tz) / 1000, b = zonedToUtc(n + 1, 0, market.tz) / 1000;
    const cnt = Math.round((b - a) / 3600), d = daytype(n);
    for (let i = 0; i < cnt; i++) {
      const h = cnt === 24 ? i : cnt === 23 ? (i < 2 ? i : i + 1) : (i < 3 ? i : i - 1);
      out.push([a + 3600 * i, n, h, d, isPeak(n, h, market)]);
    }
  }
  return out;
}

// ------------------------------------------------------------------ statistics from history
const chosen = (stats, years) => (stats ? years.filter((y) => String(y) in stats.years).map((y) => stats.years[String(y)]) : []);
const daysIn = (y, m) => nextMonth(dayNum(y, m, 1)) - dayNum(y, m, 1);
const mean1 = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1.0);

export function seasonalPrior(stats, years) {
  const rho = [...Array(12)].map(() => []), pi = [...Array(12)].map(() => []), om = [...Array(12)].map(() => []);
  for (const y of years) {
    if (!stats || !(String(y) in stats.years)) continue;
    const st = stats.years[String(y)], { base, peak, offpeak: off } = st.monthly;
    if (!st.full || base.some((b) => b == null)) continue;
    const days = [...Array(12)].map((_, m) => daysIn(+y, m + 1));
    let num = 0, den = 0;
    for (let m = 0; m < 12; m++) { num += base[m] * days[m]; den += days[m]; }
    const yearBase = num / den;
    if (yearBase < 5) continue;
    for (let m = 0; m < 12; m++) {
      rho[m].push(base[m] / yearBase);
      if (base[m] >= 5 && peak[m] != null && off[m] != null) { pi[m].push(peak[m] / base[m]); om[m].push(off[m] / base[m]); }
    }
  }
  return { rho: rho.map(mean1), pi: pi.map(mean1), omega: om.map(mean1) };
}

export function shapeFactors(stats, years) {
  const acc = [...Array(12)].map(() => [...Array(3)].map(() => [...Array(24)].map(() => [])));
  for (const st of chosen(stats, years))
    for (let m = 0; m < 12; m++) for (let d = 0; d < 3; d++) for (let h = 0; h < 24; h++) {
      const v = st.shape[m][d][h];
      if (v != null) acc[m][d][h].push(v);
    }
  return acc.map((mon) => mon.map((row) => row.map(mean1)));
}

export function monthBaseHistory(stats, years) {
  const acc = [...Array(12)].map(() => []);
  for (const st of chosen(stats, years)) st.monthly.base.forEach((v, m) => { if (v != null) acc[m].push(v); });
  return acc.map((x) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : null));
}

export function genProfile(stats, years, kind) {
  const ch = chosen(stats, years).filter((st) => st[kind]);
  const full = ch.filter((st) => st.full);
  const acc = [...Array(12)].map(() => [...Array(24)].map(() => []));
  let any = false;
  for (const st of (full.length ? full : ch)) {
    const cells = st[kind].flat().filter((v) => v != null);
    const mean = cells.length ? cells.reduce((a, b) => a + b, 0) / cells.length : 0;
    if (mean <= 0) continue;
    for (let m = 0; m < 12; m++) for (let h = 0; h < 24; h++) {
      const v = st[kind][m][h];
      if (v != null) { acc[m][h].push(v / mean); any = true; }
    }
  }
  if (!any) return null;
  return acc.map((row) => row.map((c) => (c.length ? c.reduce((a, b) => a + b, 0) / c.length : 0.0)));
}

export function batteryDay(prices, hours, roundTrip = 0.85) {
  const n = prices.length, k = hours, s = Math.sqrt(roundTrip);
  let best = 0.0;
  for (let split = k; split <= n - k; split++) {
    const low = prices.slice(0, split).sort((a, b) => a - b).slice(0, k).reduce((a, b) => a + b, 0);
    const high = prices.slice(split).sort((a, b) => b - a).slice(0, k).reduce((a, b) => a + b, 0);
    best = Math.max(best, high * s - low / s);
  }
  return best;
}

function median(xs) {
  const v = [...xs].sort((a, b) => a - b), n = v.length;
  return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}
const monthLabel = (n) => { const { y, m } = ymd(n); return `${MONTH_ABBR[m - 1]}-${String(y % 100).padStart(2, "0")}`; };

// ------------------------------------------------------------------ the curve
class Curve {
  constructor(o) { Object.assign(this, o); }
  index(period) { const out = []; for (let i = 0; i < this.day.length; i++) if (this.day[i] >= period.start && this.day[i] < period.end) out.push(i); return out; }
  covers(period) { return this.day.length > 0 && this.day[0] <= period.start && period.end <= this.day[this.day.length - 1] + 1; }
  product(period) {
    const idx = this.index(period);
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return { base: avg(idx.map((i) => this.price[i])), peak: avg(idx.filter((i) => this.peak[i]).map((i) => this.price[i])),
      offpeak: avg(idx.filter((i) => !this.peak[i]).map((i) => this.price[i])), hours: idx.length };
  }
  block(period, weekdays, hFrom, hTo) {
    const idx = this.index(period).filter((i) => weekdays.has(weekday(this.day[i])) && this.hour[i] >= hFrom && this.hour[i] < hTo);
    return { price: idx.length ? idx.reduce((a, i) => a + this.price[i], 0) / idx.length : null, hours: idx.length };
  }
  capture(period, profile) {
    let num = 0, den = 0, sum = 0;
    const idx = this.index(period);
    for (const i of idx) {
      const g = profile[ymd(this.day[i]).m - 1][this.hour[i]];
      num += this.price[i] * g; den += g; sum += this.price[i];
    }
    const base = idx.length ? sum / idx.length : null, price = den > 0 ? num / den : null;
    return { price, base, rate: price != null && base ? price / base : null };
  }
  battery(period, hours, roundTrip) {
    const days = new Map();
    for (const i of this.index(period)) { if (!days.has(this.day[i])) days.set(this.day[i], []); days.get(this.day[i]).push(this.price[i]); }
    const vals = [...days.values()].map((p) => batteryDay(p, hours, roundTrip));
    return { per_day: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, total: vals.reduce((a, b) => a + b, 0), days: vals.length };
  }
}

export function build(quotes, marketCode = "DE", stats = null, years = [], mode = "multiplicative") {
  const mkt = getMarket(marketCode);
  const rows = [], notes = [];
  for (const q of quotes) {
    let per;
    try { per = parse(q.product, 0); } catch (e) { notes.push(e.message); continue; }
    if (!(per.kind in GRANULARITY)) { notes.push(`${per.label}: only months, quarters, seasons and years build the curve`); continue; }
    for (const [profile, value] of [["base", q.base], ["peak", q.peak]])
      if (value != null) rows.push({ label: per.label, kind: per.kind, profile, quote: +value, period: per });
  }
  const empty = { market: mkt, months: [], checks: [], t: [], price: [], day: [], hour: [], peak: [], level: null, notes };
  if (!rows.length) return new Curve(empty);
  rows.sort((a, b) => GRANULARITY[a.kind] - GRANULARITY[b.kind] || a.period.start - b.period.start || (a.profile !== "base") - (b.profile !== "base"));

  const months = monthsBetween(Math.min(...rows.map((r) => r.period.start)), Math.max(...rows.map((r) => r.period.end)));
  const n = months.length;
  const hours = months.map((m) => {
    const d = delivery({ kind: "Month", label: "", start: m, end: nextMonth(m), days: nextMonth(m) - m, lastDay: nextMonth(m) - 1 }, mkt.code);
    return [d.hours.base, d.hours.peak, d.hours.offpeak];
  });
  const prior = seasonalPrior(stats, years);
  const coeffs = (r) => {
    const a = new Array(2 * n).fill(0.0);
    const idx = months.map((m, k) => (r.period.start <= m && m < r.period.end ? k : -1)).filter((k) => k >= 0);
    if (r.profile === "base") {
      let tot = 0; for (const k of idx) tot += hours[k][0];
      for (const k of idx) { a[2 * k] = hours[k][1] / tot; a[2 * k + 1] = hours[k][2] / tot; }
    } else {
      let tot = 0; for (const k of idx) tot += hours[k][1];
      for (const k of idx) a[2 * k] = hours[k][1] / tot;
    }
    return a;
  };
  const dot = (u, v) => { let s = 0; for (let i = 0; i < u.length; i++) s += u[i] * v[i]; return s; };

  const shape = [];
  for (const m of months) { const c = ymd(m).m - 1; shape.push(prior.rho[c] * prior.pi[c], prior.rho[c] * prior.omega[c]); }
  const implied = [];
  for (const r of rows) { const s = dot(coeffs(r), shape); if (s > 0) implied.push(r.quote / s); }
  const level = implied.length ? median(implied) : 0.0;
  const xhat = shape.map((s) => level * s);
  const scale = xhat.map((v) => Math.max(Math.abs(v), 1.0));

  const basis = [], kept = [], dropped = [], R = [];
  for (const r of rows) {
    const a = coeffs(r), b = a.map((ai, i) => ai * scale[i]);
    let u = b.slice();
    const proj = [];
    for (const q of basis) { const c = dot(u, q); proj.push(c); u = u.map((x, i) => x - c * q[i]); }
    basis.forEach((q, j) => { const c = dot(u, q); proj[j] += c; u = u.map((x, i) => x - c * q[i]); });
    const norm = Math.sqrt(dot(u, u));
    if (norm > 1e-9 * Math.sqrt(dot(b, b))) { basis.push(u.map((x) => x / norm)); R.push([...proj, norm]); kept.push([r, a]); }
    else dropped.push([r, a]);
  }
  const cvec = [];
  kept.forEach(([r, a], i) => {
    let rhs = r.quote - dot(a, xhat);
    for (let j = 0; j < i; j++) rhs -= R[i][j] * cvec[j];
    cvec.push(rhs / R[i][i]);
  });
  const z = new Array(2 * n).fill(0).map((_, k) => { let s = 0; for (let j = 0; j < basis.length; j++) s += cvec[j] * basis[j][k]; return s; });
  const x = xhat.map((xh, i) => xh + scale[i] * z[i]);

  const checks = [];
  for (const [r, a] of [...kept, ...dropped]) {
    const val = dot(a, x), isKept = kept.some(([k]) => k === r);
    if (!isKept && Math.abs(r.quote - val) > TOL) checks.push({ label: r.label, profile: r.profile, quote: r.quote, implied: val, diff: r.quote - val, kept: false });
  }
  const covered = new Set();
  for (const [r] of kept) months.forEach((m, k) => { if (r.period.start <= m && m < r.period.end) covered.add(k); });
  const outMonths = months.map((m, k) => {
    const [hb, hp, ho] = hours[k], p = x[2 * k], o = x[2 * k + 1];
    const quoted = [...new Set(kept.filter(([r]) => r.kind === "Month" && r.period.start === m).map(([r]) => r.profile))].sort();
    return { month: m, label: monthLabel(m), base: (p * hp + o * ho) / hb, peak: p, offpeak: o,
      hours: { base: hb, peak: hp, offpeak: ho }, quoted, constrained: covered.has(k), prior: { peak: xhat[2 * k], offpeak: xhat[2 * k + 1] } };
  });

  const F = shapeFactors(stats, years), hist = monthBaseHistory(stats, years);
  const known = hist.filter((v) => v != null);
  const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : level;
  const t = [], price = [], day = [], hour = [], peak = [];
  months.forEach((m, k) => {
    const hs = monthHours(m, mkt), mi = ymd(m).m - 1;
    const f = hs.map(([, , h, d]) => F[mi][d][h]);
    const mb = hist[mi] != null ? hist[mi] : fallback;
    const vals = new Array(hs.length);
    for (const [isPk, target] of [[true, x[2 * k]], [false, x[2 * k + 1]]]) {
      const idx = []; hs.forEach((row, i) => { if (row[4] === isPk) idx.push(i); });
      if (!idx.length) continue;
      let sf = 0; for (const i of idx) sf += f[i];
      const meanF = sf / idx.length;
      // scaling a block priced at or below zero would turn its shape upside down, so those go additive
      if (mode === "multiplicative" && meanF > 0.05 && target > 0) for (const i of idx) vals[i] = target * f[i] / meanF;
      else for (const i of idx) vals[i] = target + (f[i] - meanF) * mb;
    }
    hs.forEach((row, i) => { t.push(row[0]); day.push(row[1]); hour.push(row[2]); peak.push(row[4]); price.push(vals[i]); });
  });
  if (!stats) notes.push("No history for this zone yet: months nobody quoted are flat at the quotes' level, and hours are flat within peak and off-peak.");
  return new Curve({ market: mkt, months: outMonths, checks, t, price, day, hour, peak, level, notes });
}
