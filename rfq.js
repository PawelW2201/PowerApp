// rfq.js — what a solar or wind PPA and a battery toll are worth against the forward curve.
// A port of PowerDesk's powerdesk/rfq.py (the reference); tests/rfq.test.mjs checks the two agree.
//
// Scenarios: each chosen history year. The curve shapes a month's hours with history's average
// shape (each hour's price over its month's mean, by day type and hour), scaled or shifted so each
// block averages its forward price. A scenario takes the same step with one year's actual hours,
// so the scenarios average back to the curve while keeping that year's day-to-day swings and its
// weather (sunny and windy hours are cheap hours). Days are averaged per day type and weighted by
// the future month's calendar. A history month whose mean is within 5 EUR/MWh of zero sits out.
//
// PPA (pay as produced): base over the tenor -> seasons -> daily shape on the curve -> weather ->
// negative hours (if curtailed) -> capture-rate trend -> balancing -> risk -> margin = offer.
// Toll (EUR/MW/year): intrinsic (the curve's daily shape) -> extrinsic (history's daily swings) ->
// the share of it trading won't capture -> availability -> degradation -> spread trend -> other
// revenue -> risk -> margin = offer. Both levelized with a discount rate, monthly, mid-month.
// Revenue floor: the provider pays max(F - R, 0) after a year whose revenue R ends below F, a put
// on R. R is lognormal around the toll's expected revenue with log variance vol_year^2 (a year's
// own surprise) + vol_drift^2 (t_start + T/3) (the level's drift, earned through the year like an
// average), so each year is a Black-76 put; an upside share above a threshold is a call.
import { build, genProfile, daytype } from "./curve.js";
import { black76, N } from "./options.js";
import { getMarket, zonedToUtc, ymd, dayNum, localParts } from "./calendar.js";

export const MIN_MEAN = 5.0;
const COMMISSIONING_H = 31 * 24;

// ------------------------------------------------------------------ calendar helpers
export function addMonths(n, k) { const { y, m } = ymd(n); const i = y * 12 + m - 1 + k; return dayNum(Math.floor(i / 12), (i % 12) + 1, 1); }
const firstOfMonth = (n) => { const { y, m } = ymd(n); return dayNum(y, m, 1); };
export function daytypeCounts(month) {
  const out = [0, 0, 0];
  for (let n = month, end = addMonths(month, 1); n < end; n++) out[daytype(n)]++;
  return out;
}
const tau = (month, today) => (month + 14 - today) / 365.25;
const monthLabel = (n) => { const { y, m } = ymd(n); return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]}-${String(y % 100).padStart(2, "0")}`; };

// ------------------------------------------------------------------ the battery
// Best dispatch of a 1 MW battery holding `hours` MWh over one day, empty at the start and the
// end, at most `cycles` full cycles, whole hours of 1 MWh. Charging 1 MWh buys 1/sqrt(rt) from
// the grid, discharging sells sqrt(rt). Returns [EUR, MWh discharged]; never below zero (idle).
export function batteryDp(prices, hours, roundTrip = 0.85, cycles = 1) {
  const s = Math.sqrt(roundTrip), E = Math.trunc(hours), cap = Math.round(cycles * hours);
  let V = [...Array(E + 1)].map(() => new Array(cap + 1).fill(-Infinity));
  V[0][0] = 0.0;
  for (const p of prices) {
    const buy = p / s, sell = p * s;
    const W = V.map((row) => row.slice());
    for (let soc = 0; soc <= E; soc++) {
      const row = V[soc];
      for (let dis = 0; dis <= cap; dis++) {
        const v = row[dis];
        if (v === -Infinity) continue;
        if (soc < E) { const w = v - buy; if (w > W[soc + 1][dis]) W[soc + 1][dis] = w; }
        if (soc > 0 && dis < cap) { const w = v + sell; if (w > W[soc - 1][dis + 1]) W[soc - 1][dis + 1] = w; }
      }
    }
    V = W;
  }
  let best = 0.0, used = 0;
  for (let dis = 0; dis <= cap; dis++) if (V[0][dis] > best + 1e-12) { best = V[0][dis]; used = dis; }
  return [best, used];
}

// ------------------------------------------------------------------ history as scenarios
// Onshore + offshore wind; a technology first reporting more than a month in counts as zero until then.
export function windSeries(doc, n) {
  const cols = [];
  for (const p of ["wind_onshore", "wind_offshore"]) {
    const xs = doc[p] || [];
    const first = xs.findIndex((v) => v != null);
    if (first >= 0) cols.push([xs, first >= COMMISSIONING_H ? first : 0]);
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let total = cols.length ? 0.0 : null;
    for (const [xs, first] of cols) {
      const v = i < xs.length ? xs[i] : null;
      if (v != null) total += v;
      else if (i >= first) { total = null; break; }
    }
    out[i] = total;
  }
  return out;
}

// Map of "year-month" (month 1..12) -> { year, month, days: [{ daytype, price, gen, peak }], mean }
export function historyMonths(docs, marketCode, kind = null) {
  const mkt = getMarket(marketCode), out = new Map();
  for (const year of Object.keys(docs).map(Number).sort((a, b) => a - b)) {
    const doc = docs[year], price = doc.price, n = price.length;
    const gen = kind === "solar" ? (doc.solar || new Array(n).fill(null)) : kind === "wind" ? windSeries(doc, n) : new Array(n).fill(null);
    const p0 = localParts(doc.start * 1000, mkt.tz);
    const byMonth = new Map();
    for (let day = dayNum(p0.y, p0.m, p0.d), i = 0; i < n; day++) {
      const a = zonedToUtc(day, 0, mkt.tz) / 1000, b = zonedToUtc(day + 1, 0, mkt.tz) / 1000;
      const cnt = Math.round((b - a) / 3600);
      const d = { daytype: daytype(day), price: [], gen: [], hour: [] };
      for (let j = 0; j < cnt && i < n; j++, i++) {
        const h = cnt === 24 ? j : cnt === 23 ? (j < 2 ? j : j + 1) : (j < 3 ? j : j - 1);
        d.price.push(price[i]); d.gen.push(i < gen.length ? gen[i] : null); d.hour.push(h);
      }
      const { y, m } = ymd(day);
      if (!byMonth.has(`${y}-${m}`)) byMonth.set(`${y}-${m}`, { y, m, days: [] });
      byMonth.get(`${y}-${m}`).days.push(d);
    }
    for (const { y, m, days } of byMonth.values()) {
      if (y !== year) continue;
      let s = 0, c = 0;
      for (const d of days) for (const p of d.price) if (p != null) { s += p; c++; }
      if (!c || Math.abs(s / c) < MIN_MEAN) continue;
      out.set(`${y}-${m}`, { year: y, month: m, days, mean: s / c });
    }
  }
  return out;
}

// How each hour of a history month becomes an hour of the curve's month `mo`: the curve's own
// step for its blocks, applied to that hour's price over its month's mean.
export function scalers(hm, mo) {
  const sh = mo.shaping;
  const one = (blk) => {
    const b = sh[blk];
    if (!b) return null;
    if (b.mult) { const k = b.price / (b.mean_f * hm.mean); return (p) => p * k; }
    const F = b.price, mf = b.mean_f, mb = sh.mb, m = hm.mean;
    return (p) => F + (p / m - mf) * mb;
  };
  const sp = one("peak"), so = one("offpeak");
  return [sp || so, so || sp];
}

// The days of one month of the curve as [day type, peak hours, number of days]. A history day stands
// in for future days of its day type and takes its blocks from them, so a holiday that falls on a
// weekday one year and on a Saturday the next doesn't move hours between peak and off-peak.
const cmpList = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };
export function dayGroups(cv, idx) {
  const days = new Map();
  for (const i of idx) {
    const d = cv.day[i];
    if (!days.has(d)) days.set(d, [daytype(d), new Set()]);
    if (cv.peak[i]) days.get(d)[1].add(cv.hour[i]);
  }
  const count = new Map();
  for (const [t, hs] of days.values()) {
    const list = [...hs].sort((a, b) => a - b), key = `${t}|${list.join(",")}`;
    if (!count.has(key)) count.set(key, { t, hs: new Set(list), list, n: 0 });
    count.get(key).n++;
  }
  return [...count.values()].sort((a, b) => a.t - b.t || cmpList(a.list, b.list)).map((g) => [g.t, g.hs, g.n]);
}

// Sum over the month's day groups of (days in the group) x (mean over history days of its day type
// of each(day, peakHours)); a day type history lacks uses all its days.
function byGroup(hm, groups, each, cols, complete = false) {
  const out = new Array(cols).fill(0.0);
  let seenAny = false;
  for (const [t, peakHours, n] of groups) {
    let acc = null, k = 0;
    for (const pool of [hm.days.filter((d) => d.daytype === t), hm.days]) {
      acc = new Array(cols).fill(0.0); k = 0;
      for (const d of pool) {
        if (complete && (d.price.length < 23 || d.price.some((p) => p == null))) continue;
        const r = each(d, peakHours);
        if (r == null) continue;
        for (let i = 0; i < cols; i++) acc[i] += r[i];
        k++;
      }
      if (k) break;
    }
    if (!k) continue;
    seenAny = true;
    for (let i = 0; i < cols; i++) out[i] += n * acc[i] / k;
  }
  return seenAny ? out : null;
}

export function ppaMonth(hm, mo, curtail, groups) {
  const [sp, so] = scalers(hm, mo);
  const each = (d, peakHours) => {
    let r = 0.0, v = 0.0, va = 0.0, seen = false;
    for (let i = 0; i < d.price.length; i++) {
      const p = d.price[i], g = d.gen[i];
      if (p == null || g == null) continue;
      seen = true;
      const q = peakHours.has(d.hour[i]) ? sp(p) : so(p);
      va += g;
      if (curtail && q < 0) continue;
      r += q * g; v += g;
    }
    return seen ? [r, v, va] : null;
  };
  const w = byGroup(hm, groups, each, 3);
  if (!w || w[2] <= 0) return null;
  if (w[1] <= 0) return [0.0, 1.0];
  return [w[0] / w[1], 1.0 - w[1] / w[2]];
}

export function tollMonth(hm, mo, groups, hours, roundTrip, cycles) {
  const [sp, so] = scalers(hm, mo);
  const each = (d, peakHours) => batteryDp(d.price.map((p, i) => (peakHours.has(d.hour[i]) ? sp(p) : so(p))), hours, roundTrip, cycles);
  return byGroup(hm, groups, each, 2, true);
}

// ------------------------------------------------------------------ the curve over the tenor
// The curve from the quotes, extended to the end of the tenor by assumed calendar years at the
// level of its last twelve months, grown at `growth` a year. Returns { cv, assumed }.
export function tenorCurve(quotes, marketCode, stats, years, mode, start, months, growth) {
  const cv = build(quotes, marketCode, stats, years, mode);
  if (!cv.months.length) return { cv, assumed: [] };
  const end = addMonths(start, months), last = cv.months[cv.months.length - 1].month;
  if (addMonths(last, 1) >= end) return { cv, assumed: [] };
  let ref;
  if (cv.months.length >= 12) {
    const tail = cv.months.slice(-12);
    ref = tail.reduce((a, m) => a + m.base * m.hours.base, 0) / tail.reduce((a, m) => a + m.hours.base, 0);
  } else ref = cv.level;
  const { y: ly, m: lm } = ymd(last);
  const assumed = [];
  for (let y = lm < 12 ? ly : ly + 1, yEnd = ymd(addMonths(end, -1)).y; y <= yEnd; y++)
    assumed.push({ product: `Cal${String(y % 100).padStart(2, "0")}`, base: ref * (1 + growth) ** (y - ly), peak: null });
  return { cv: build([...quotes, ...assumed], marketCode, stats, years, mode), assumed };
}

function monthIndex(cv) {
  const idx = new Map();
  for (let i = 0; i < cv.day.length; i++) {
    const m = firstOfMonth(cv.day[i]);
    if (!idx.has(m)) idx.set(m, []);
    idx.get(m).push(i);
  }
  return idx;
}
function tenorMonths(cv, start, months) {
  const by = new Map(cv.months.map((m) => [m.month, m]));
  const out = [];
  for (let k = 0; k < months; k++) {
    const m = addMonths(start, k);
    if (!by.has(m)) throw new Error(`${monthLabel(m)} is outside the curve (${cv.months[0].label} to ${cv.months[cv.months.length - 1].label})`);
    out.push(by.get(m));
  }
  return out;
}
function check(cv, start, today) {
  if (!cv.months.length) throw new Error("no curve: type quotes on the Curve tab first");
  if (start < addMonths(firstOfMonth(today), 1)) throw new Error("the tenor has to start next month or later");
  if (start < cv.months[0].month) throw new Error(`the tenor starts before the curve does (${cv.months[0].label})`);
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// ------------------------------------------------------------------ PPA
export function ppa(cv, docs, stats, years, o) {
  return ppaValue(ppaMonths(cv, docs, stats, years, o), o);
}

// The slow part of a PPA, which only the curve, the history and the tenor change: per month, the
// output's seasonal share, its capture price on the curve, and each scenario's.
export function ppaMonths(cv, docs, stats, years, { kind = "solar", start, months, today }) {
  check(cv, start, today);
  const mkt = cv.market, tenor = tenorMonths(cv, start, months);
  const prof = genProfile(stats, years, kind);
  if (!prof) throw new Error(`no ${kind} output in the chosen history years`);
  const monthMean = prof.map((r) => sum(r) / 24), daysNorm = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const tot = sum(monthMean.map((mm, i) => mm * daysNorm[i]));
  const share = monthMean.map((mm, i) => mm * daysNorm[i] / tot);
  const hist = historyMonths(docs, mkt.code, kind);
  const ys = Object.keys(docs).map(Number).sort((a, b) => a - b);
  const yRef = ys.length ? sum(ys) / ys.length : ymd(start).y;
  const idx = monthIndex(cv);

  const rows = tenor.map((mo, k) => {
    const m = mo.month, { y: my, m: mm } = ymd(m), c = mm - 1;
    const groups = dayGroups(cv, idx.get(m));
    let num = 0, den = 0, numC = 0, denC = 0;
    for (const i of idx.get(m)) {
      const g = prof[c][cv.hour[i]];
      num += cv.price[i] * g; den += g;
      if (cv.price[i] >= 0) { numC += cv.price[i] * g; denC += g; }
    }
    const cpCurve = den > 0 ? num / den : mo.base;
    const scen = new Map(), scenC = new Map();
    for (const y of ys) {
      const hm = hist.get(`${y}-${mm}`);
      if (!hm) continue;
      const a = ppaMonth(hm, mo, false, groups), b = ppaMonth(hm, mo, true, groups);
      if (a && b) { scen.set(y, a[0]); scenC.set(y, b); }
    }
    return { month: m, k, year: my, base: mo.base, hours: mo.hours.base, share: share[c], cpCurve,
      curveC: [denC > 0 ? numC / denC : 0.0, den > 0 ? 1 - denC / den : 0.0], scen, scenC };
  });
  return { kind, start, months, rows, ys, yRef };
}

// The offer for `capacity` MW producing `yield_mwh` MWh per MW a year (P50).
export function ppaValue(pm, { capacity = 10, yield_mwh = 1000, degradation = 0, curtail = false, balancing = 0, risk = 0,
  margin = 0, trend = 0, discount = 0, today }) {
  const { kind, ys, yRef } = pm;
  const rows = pm.rows.map((r) => ({ ...r, vol: capacity * yield_mwh * r.share * (1 - degradation) ** Math.floor(r.k / 12),
    df: (1 + discount) ** -tau(r.month, today), trend: trend * (r.year - yRef) * r.base }));

  const avgScen = (r) => (r.scen.size ? sum([...r.scen.values()]) / r.scen.size : r.cpCurve);
  const avgScenC = (r) => {
    if (!r.scenC.size) return r.curveC;
    const v = [...r.scenC.values()];
    return [sum(v.map((x) => x[0])) / v.length, sum(v.map((x) => x[1])) / v.length];
  };
  const value = (rs, pick = null) => {
    const wt = sum(rs.map((r) => r.df * r.hours)), wv = sum(rs.map((r) => r.df * r.vol));
    const flat = sum(rs.map((r) => r.df * r.hours * r.base)) / wt;
    const vbase = sum(rs.map((r) => r.df * r.vol * r.base)) / wv;
    const curveCp = sum(rs.map((r) => r.df * r.vol * r.cpCurve)) / wv;
    const scen = rs.map((r) => (pick != null && r.scen.has(pick) ? r.scen.get(pick) : avgScen(r)));
    const weather = sum(rs.map((r, i) => r.df * r.vol * scen[i])) / wv;
    let paid, neg, vols;
    if (curtail) {
      const sc = rs.map((r) => (pick != null && r.scenC.has(pick) ? r.scenC.get(pick) : avgScenC(r)));
      paid = rs.map((r, i) => r.df * r.vol * (1 - sc[i][1]));
      const wp = sum(paid);
      neg = wp > 0 ? sum(paid.map((p, i) => p * sc[i][0])) / wp : 0.0;
      vols = rs.map((r, i) => r.vol * (1 - sc[i][1]));
    } else {
      paid = rs.map((r) => r.df * r.vol);
      neg = weather;
      vols = rs.map((r) => r.vol);
    }
    const wp = sum(paid);
    const tr = wp > 0 ? sum(paid.map((p, i) => p * rs[i].trend)) / wp : 0.0;
    return { flat, vbase, curve: curveCp, weather, neg, trend: tr, fair: neg + tr - balancing, volume: sum(vols), volumeAll: sum(rs.map((r) => r.vol)) };
  };

  const v = value(rows), offer = v.fair - risk - margin;
  const steps = [
    { key: "base", label: "Base over the tenor", value: v.flat, total: true },
    { key: "season", label: "When it produces: seasons", value: v.vbase - v.flat },
    { key: "shape", label: "When it produces: hours, on the curve", value: v.curve - v.vbase },
    { key: "weather", label: "Weather: history's sunny or windy hours", value: v.weather - v.curve },
  ];
  if (curtail) steps.push({ key: "negative", label: "No output below zero", value: v.neg - v.weather });
  steps.push(
    { key: "trend", label: "Trend in capture rates", value: v.trend },
    { key: "balancing", label: "Balancing", value: -balancing },
    { key: "risk", label: "Risk premium", value: -risk },
    { key: "margin", label: "Margin", value: -margin },
    { key: "offer", label: "Offer", value: offer, total: true });
  const yearsOut = [...new Set(rows.map((r) => r.year))].sort((a, b) => a - b).map((y) => {
    const rs = rows.filter((r) => r.year === y), vy = value(rs);
    const baseY = sum(rs.map((r) => r.hours * r.base)) / sum(rs.map((r) => r.hours));
    const per = ys.filter((s) => rs.some((r) => r.scen.has(s))).map((s) => value(rs, s).weather);
    return { year: y, months: rs.length, base: baseY, rate_curve: baseY ? vy.curve / baseY : null, rate: baseY ? vy.weather / baseY : null,
      rate_min: per.length && baseY ? Math.min(...per) / baseY : null, rate_max: per.length && baseY ? Math.max(...per) / baseY : null, fair: vy.fair };
  });
  const scenarios = ys.filter((y) => rows.some((r) => r.scen.has(y)))
    .map((y) => ({ year: y, fair: value(rows, y).fair, months: rows.filter((r) => r.scen.has(y)).length }));
  const missing = rows.filter((r) => !r.scen.size).length;
  const notes = missing ? [`${missing} of ${rows.length} months have no history with output in the chosen years: they use the curve's capture.`] : [];
  return { kind, start: pm.start, months: pm.months, steps, fair: v.fair, offer, volume: v.volume, curtailed: v.volumeAll ? 1 - v.volume / v.volumeAll : 0.0,
    years: yearsOut, scenarios, y_ref: yRef, notes };
}

// ------------------------------------------------------------------ toll
export function toll(cv, docs, years, o) {
  return tollValue(tollMonths(cv, docs, years, o), o);
}

// The slow part of a toll, which only the curve, the history, the tenor and the battery change:
// per month, the intrinsic value and each scenario's, in EUR per MW.
export function tollMonths(cv, docs, years, { start, months, hours = 2, round_trip = 0.85, cycles = 1, today }) {
  check(cv, start, today);
  const mkt = cv.market, tenor = tenorMonths(cv, start, months);
  const hist = historyMonths(docs, mkt.code, null);
  const ys = Object.keys(docs).map(Number).sort((a, b) => a - b);
  const yRef = ys.length ? sum(ys) / ys.length : ymd(start).y;
  const idx = monthIndex(cv), cache = new Map();
  const rows = tenor.map((mo, k) => {
    const m = mo.month, { y: my, m: mm } = ymd(m);
    const days = new Map();
    for (const i of idx.get(m)) { if (!days.has(cv.day[i])) days.set(cv.day[i], []); days.get(cv.day[i]).push(cv.price[i]); }
    let intrinsic = 0.0;
    for (const p of days.values()) {
      const key = p.join(",");
      if (!cache.has(key)) cache.set(key, batteryDp(p, hours, round_trip, cycles));
      intrinsic += cache.get(key)[0];
    }
    const groups = dayGroups(cv, idx.get(m)), ndays = sum(groups.map((g) => g[2])), scen = new Map(), used = [];
    for (const y of ys) {
      const hm = hist.get(`${y}-${mm}`);
      if (!hm) continue;
      const r = tollMonth(hm, mo, groups, hours, round_trip, cycles);
      if (r) { scen.set(y, r[0]); used.push(r[1] / ndays); }
    }
    return { month: m, k, year: my, intrinsic, scen, spot: scen.size ? sum([...scen.values()]) / scen.size : intrinsic,
      mwhDay: used.length ? sum(used) / used.length : null };
  });
  return { start, months, hours, rows, ys, yRef };
}

// The toll in EUR per MW per year.
export function tollValue(tm, { availability = 0.97, degradation = 0.02, realism = 0.7, other = 0, trend = 0, risk = 0.1,
  margin = 0.05, discount = 0, today }) {
  const { ys, yRef, months, hours } = tm;
  const rows = tm.rows.map((r) => ({ ...r, df: (1 + discount) ** -tau(r.month, today),
    adj: availability * (1 - degradation) ** Math.floor(r.k / 12) * (1 + trend) ** (r.year - yRef) }));
  const wdf = sum(rows.map((r) => r.df));
  const lev = (xs) => 12 * sum(rows.map((r, i) => r.df * xs[i])) / wdf;
  const real = (r, s) => r.intrinsic + realism * (s - r.intrinsic);
  const a0 = lev(rows.map((r) => r.intrinsic)), a1 = lev(rows.map((r) => r.spot));
  const a2 = a0 + realism * (a1 - a0), a3 = availability * a2;
  const a4 = lev(rows.map((r) => real(r, r.spot) * availability * (1 - degradation) ** Math.floor(r.k / 12)));
  const a5 = lev(rows.map((r) => real(r, r.spot) * r.adj));
  const a6 = a5 + other, a7 = a6 * (1 - risk), a8 = a7 * (1 - margin);
  const steps = [
    { key: "intrinsic", label: "Intrinsic: the curve's daily shape", value: a0, total: true },
    { key: "extrinsic", label: "Extrinsic: history's daily swings", value: a1 - a0 },
    { key: "realism", label: "Extrinsic you won't capture", value: a2 - a1 },
    { key: "availability", label: "Availability", value: a3 - a2 },
    { key: "degradation", label: "Degradation", value: a4 - a3 },
    { key: "trend", label: "Trend in daily spreads", value: a5 - a4 },
    { key: "other", label: "Other revenue (yours)", value: other },
    { key: "risk", label: "Risk premium", value: a7 - a6 },
    { key: "margin", label: "Margin", value: a8 - a7 },
    { key: "offer", label: "Toll offer", value: a8, total: true },
  ];
  const yearsOut = [];
  for (let k = 0; k < Math.ceil(months / 12); k++) {
    const rs = rows.filter((r) => Math.floor(r.k / 12) === k);
    const per = ys.filter((y) => rs.some((r) => r.scen.has(y))).map((y) => sum(rs.map((r) => (r.scen.has(y) ? r.scen.get(y) : r.spot))));
    yearsOut.push({ from: rs[0].month, months: rs.length, intrinsic: sum(rs.map((r) => r.intrinsic)), spot: sum(rs.map((r) => r.spot)),
      spot_min: per.length ? Math.min(...per) : null, spot_max: per.length ? Math.max(...per) : null,
      net: sum(rs.map((r) => real(r, r.spot) * r.adj)) + other * rs.length / 12 });
  }
  const scenarios = ys.filter((y) => rows.some((r) => r.scen.has(y)))
    .map((y) => ({ year: y, value: lev(rows.map((r) => real(r, r.scen.has(y) ? r.scen.get(y) : r.spot) * r.adj)) + other,
      months: rows.filter((r) => r.scen.has(y)).length }));
  const used = rows.map((r) => r.mwhDay).filter((x) => x != null);
  const missing = rows.filter((r) => !r.scen.size).length;
  const notes = missing ? [`${missing} of ${rows.length} months have no complete history days in the chosen years: they use the intrinsic value.`] : [];
  return { start: tm.start, months, steps, offer: a8, spot: a1, intrinsic: a0, cycles_per_day: used.length ? sum(used) / used.length / hours : null,
    years: yearsOut, scenarios, y_ref: yRef, notes };
}

// ------------------------------------------------------------------ revenue floor
// A floor on the battery of tollMonths: `floor` and `cap` (the threshold for an upside share) are
// fractions of the levelized expected revenue, one level for every year; the fee is paid at each
// year's end; `margin` loads the fair fee and the share.
export function floorValue(tm, { floor = 0.7, vol_year = 0.25, vol_drift = 0.1, cap = 1.0, margin = 0.15, availability = 0.97,
  degradation = 0.02, realism = 0.7, other = 0, trend = 0, discount = 0, today }) {
  const { yRef, months } = tm;
  const rows = tm.rows.map((r) => ({ ...r, df: (1 + discount) ** -tau(r.month, today),
    adj: availability * (1 - degradation) ** Math.floor(r.k / 12) * (1 + trend) ** (r.year - yRef) }));
  const real = rows.map((r) => (r.intrinsic + realism * (r.spot - r.intrinsic)) * r.adj);
  const wdf = sum(rows.map((r) => r.df));
  const expected = 12 * sum(rows.map((r, i) => r.df * real[i])) / wdf + other;
  const level = floor * expected, capLevel = cap * expected;
  const years = [];
  for (let k = 0; k < Math.ceil(months / 12); k++) {
    const idx = [];
    rows.forEach((r, i) => { if (Math.floor(r.k / 12) === k) idx.push(i); });
    const n = idx.length, first = rows[idx[0]].month;
    const t0 = (first - today) / 365.25, t1 = (addMonths(first, n) - today) / 365.25;
    const v = vol_year * vol_year + vol_drift * vol_drift * (t0 + (t1 - t0) / 3);
    const e = sum(idx.map((i) => real[i])) + other * n / 12;
    const f = level * n / 12, c = capLevel * n / 12, df = (1 + discount) ** -t1;
    let put, call, chance;
    if (e > 0) {
      put = black76(e, f, 1.0, Math.sqrt(v), 0.0, "put");
      call = black76(e, c, 1.0, Math.sqrt(v), 0.0, "call");
      chance = f <= 0 ? 0.0 : v <= 0 ? (f > e ? 1.0 : 0.0) : N(-(Math.log(e / f) - v / 2) / Math.sqrt(v));
    } else { put = Math.max(f, 0.0); call = 0.0; chance = f > 0 ? 1.0 : 0.0; }   // nothing expected: it pays in full
    years.push({ from: first, months: n, expected: e, floor: f, sd: Math.sqrt(v), chance, payout: put, df, pv_put: df * put, pv_call: df * call });
  }
  const pvPut = sum(years.map((y) => y.pv_put)), pvCall = sum(years.map((y) => y.pv_call));
  const annuity = sum(years.map((y) => y.df * y.months / 12));
  const fairFee = pvPut / annuity, shareFair = pvCall > 0 ? pvPut / pvCall : null;
  return { start: tm.start, months, expected, level, cap_level: capLevel, fair_fee: fairFee, fee: fairFee * (1 + margin),
    share_fair: shareFair, share: shareFair != null ? shareFair * (1 + margin) : null,
    chance: sum(years.map((y) => y.chance * y.months)) / months, pv_put: pvPut, pv_call: pvCall, years };
}
