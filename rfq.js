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
// the share of it trading won't capture -> grid fee on charging -> own price impact -> availability ->
// degradation -> spread trend -> other revenue -> risk -> margin = offer. Both levelized with a
// discount rate, monthly, mid-month.
// Grid fee: a MWh drawn to charge costs its price plus the fee, so a MWh sold has to beat its buying
// price by fee / rt more; the battery drops the spreads that no longer pay.
// Cycles: the contract's limit is an average a day over each contract year, at most two in any one
// day. Each day's best revenue is known for every whole MWh discharged, so a year's budget goes to
// the steps up those revenue curves, best first (a Lagrangian; the last step is the shadow price).
// Size: the battery's own trades move the price against it, by `impact` (a share of the month's
// base price per GW of its power, estimated from history by PowerDesk) at its full power.
// Your own figure: what you expect the battery to earn in one year, all in, moved to later years by the
// curve and cut by your view of cannibalization (anchor, anchorValue); it's never stored here.
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
export const DAILY_MAX = 2;                                 // full cycles in any one day (a usual warranty term)
export const CYCLE_OPTIONS = [1.0, 1.1, 1.2, 1.3, 1.5, 2.0];  // average cycles a day, as RfQs ask for them

// The best revenue of one day for each whole number q of MWh discharged, q = 0 to maxCycles x hours:
// a 1 MW battery holding `hours` MWh, empty at the start and the end, 1 MWh an hour. Charging 1 MWh
// buys 1/sqrt(rt) from the grid, discharging sells sqrt(rt); `impact` is how far its own full power
// moves the price (EUR/MWh), so it sells that much lower and buys that much higher; `fee` is the grid's
// charge on every MWh drawn to charge (EUR/MWh). -Infinity where q can't be reached.
let bufA = new Float64Array(0), bufB = new Float64Array(0);
export function batteryCurve(prices, hours, roundTrip = 0.85, impact = 0.0, maxCycles = DAILY_MAX, fee = 0.0) {
  const s = Math.sqrt(roundTrip), E = Math.trunc(hours), cap = Math.round(maxCycles * hours), w = cap + 1, size = (E + 1) * w;
  if (bufA.length < size) { bufA = new Float64Array(size); bufB = new Float64Array(size); }
  let V = bufA, W = bufB;
  V.fill(-Infinity, 0, size);
  V[0] = 0.0;
  const n = prices.length;
  for (let t = 0; t < n; t++) {
    const p = prices[t], buy = (p + fee) / s + impact / (s * s), sell = p * s - impact * (s * s);
    // only states that can be reached by now and still end empty (the rest can't change the answer)
    const socTop = Math.min(E, t, n - t), disTop = Math.min(cap, t >> 1);
    W.set(V.subarray(0, size));                               // idle
    for (let soc = 0; soc <= socTop; soc++) {
      const row = soc * w;
      for (let dis = 0; dis <= disTop; dis++) {
        const v = V[row + dis];
        if (v === -Infinity) continue;
        if (soc < E) { const x = v - buy, j = row + w + dis; if (x > W[j]) W[j] = x; }
        if (soc > 0 && dis < cap) { const x = v + sell, j = row - w + dis + 1; if (x > W[j]) W[j] = x; }
      }
    }
    const tmp = V; V = W; W = tmp;
  }
  return Array.from(V.subarray(0, w));
}

// The best day with at most `cycles` full cycles: [EUR, MWh discharged]; never below zero (idle).
export function batteryDp(prices, hours, roundTrip = 0.85, cycles = 1, impact = 0.0, fee = 0.0) {
  let best = 0.0, used = 0;
  batteryCurve(prices, hours, roundTrip, impact, cycles, fee).forEach((v, q) => { if (v > best + 1e-12) { best = v; used = q; } });
  return [best, used];
}

// A day's revenue curve as steps up its upper concave hull from q = 0: [MWh, EUR], each worth less
// per MWh than the one before; only steps worth more than nothing.
export function daySteps(curve) {
  const hull = [];
  curve.forEach((v, q) => {
    if (v === -Infinity) return;
    while (hull.length >= 2) {
      const [q0, v0] = hull[hull.length - 2], [q1, v1] = hull[hull.length - 1];
      if ((v1 - v0) * (q - q0) <= (v - v0) * (q1 - q0)) hull.pop(); else break;
    }
    hull.push([q, v]);
  });
  const out = [];
  for (let i = 1; i < hull.length; i++) {
    const [q0, v0] = hull[i - 1], [q1, v1] = hull[i];
    if (v1 - v0 <= 0) break;
    out.push([q1 - q0, v1 - v0]);
  }
  return out;
}

// Spend a budget of MWh discharged on steps [EUR per MWh, MWh, EUR, slot], best first (`items` comes
// sorted), the last one in part. Returns [Map slot -> [EUR, MWh], shadow price (0 if budget is left)].
export function spend(items, budget) {
  const got = new Map();
  let left = budget, shadow = 0.0;
  for (const [slope, mwh, eur, slot] of items) {
    if (left <= 1e-9) { shadow = slope; break; }
    const take = mwh <= left ? 1.0 : left / mwh;
    if (!got.has(slot)) got.set(slot, [0.0, 0.0]);
    const acc = got.get(slot);
    acc[0] += take * eur; acc[1] += take * mwh;
    left -= take * mwh;
    if (take < 1.0) { shadow = slope; break; }
  }
  return [got, shadow];
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

// Map of "year-month" (month 1..12) -> { year, month, days: [{ daytype, price, gen, hour }], mean }. A year's
// months are kept per document (time zones are slow to work out), so pricing again costs nothing.
const histCache = new WeakMap();
export function historyMonths(docs, marketCode, kind = null) {
  const mkt = getMarket(marketCode), out = new Map();
  for (const year of Object.keys(docs).map(Number).sort((a, b) => a - b)) {
    const doc = docs[year];
    if (!histCache.has(doc)) histCache.set(doc, new Map());
    const per = histCache.get(doc), key = `${mkt.code}|${kind}|${year}`;
    if (!per.has(key)) per.set(key, monthsOfYear(doc, year, mkt, kind));
    for (const [k, v] of per.get(key)) out.set(k, v);
  }
  return out;
}

function monthsOfYear(doc, year, mkt, kind) {
  const price = doc.price, n = price.length, out = [];
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
    out.push([`${y}-${m}`, { year: y, month: m, days, mean: s / c }]);
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
function byGroup(hm, groups, each, cols) {
  const out = new Array(cols).fill(0.0);
  let seenAny = false;
  for (const [t, peakHours, n] of groups) {
    let acc = null, k = 0;
    for (const pool of [hm.days.filter((d) => d.daytype === t), hm.days]) {
      acc = new Array(cols).fill(0.0); k = 0;
      for (const d of pool) {
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

// One scenario month as complete history days of prices on the curve's month `mo`, each with the
// number of future days it stands for (a day type's days share its future days): [days, covered].
export function historyDays(hm, mo, groups) {
  const [sp, so] = scalers(hm, mo), out = [];
  let covered = 0;
  for (const [t, peakHours, n] of groups) {
    let pool = [];
    for (const cand of [hm.days.filter((d) => d.daytype === t), hm.days]) {
      pool = cand.filter((d) => d.price.length >= 23 && d.price.every((p) => p != null));
      if (pool.length) break;
    }
    if (!pool.length) continue;
    covered += n;
    const w = n / pool.length;
    for (const d of pool) out.push([d.price.map((p, i) => (peakHours.has(d.hour[i]) ? sp(p) : so(p))), w]);
  }
  return [out, covered];
}

// A month of the curve as its distinct days: [hourly prices, how many days look like that, a key].
export function curveDays(cv, idx) {
  const days = new Map();
  for (const i of idx) { if (!days.has(cv.day[i])) days.set(cv.day[i], []); days.get(cv.day[i]).push(cv.price[i]); }
  const out = new Map();
  for (const p of days.values()) {
    const key = p.join(",");
    if (out.has(key)) out.get(key)[1]++; else out.set(key, [p, 1, key]);
  }
  return [...out.values()];
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

const poolCache = new WeakMap(), POOLS_KEPT = 12;   // plan -> Map(battery -> ranked steps), least recently used out

// What a toll prices, before any battery: the tenor's months, each as the curve's distinct days and each
// scenario's history days on the curve. Depends on the curve, the history and the tenor only, so the
// app keeps it while the battery changes.
export function tollPlan(cv, docs, years, { start, months, today }) {
  check(cv, start, today);
  const mkt = cv.market, tenor = tenorMonths(cv, start, months);
  const hist = historyMonths(docs, mkt.code, null);
  const ys = Object.keys(docs).map(Number).sort((a, b) => a - b);
  const yRef = ys.length ? sum(ys) / ys.length : ymd(start).y;
  const idx = monthIndex(cv);
  const days = tenor.map((mo) => {                // [curve's days, its number of days, Map year -> [history days, covered]]
    const m = mo.month, { m: mm } = ymd(m), groups = dayGroups(cv, idx.get(m)), scen = new Map();
    for (const y of ys) {
      const hm = hist.get(`${y}-${mm}`);
      if (!hm) continue;
      const [ds, covered] = historyDays(hm, mo, groups);
      if (covered) scen.set(y, [ds, covered]);
    }
    return [curveDays(cv, idx.get(m)), sum(groups.map((g) => g[2])), scen];
  });
  return { start, months, tenor, days, ys, yRef };
}

// The slow part of a toll, which only the curve, the history, the tenor and the battery change: per
// month, the intrinsic value and each scenario's, in EUR per MW. `cycles` is the contract's average a
// day over each contract year (at most DAILY_MAX in a day); `mw` the project's power and `impact` the
// price move per GW of it as a share of the month's base price; `fee` the grid's charge per MWh drawn
// to charge. With `free` the months also carry the same battery as a price-taker without the fee and
// with it (the bridge's fee and own-impact steps); `options` adds each cycle limit. `plan` (from
// tollPlan, for the same curve, history and tenor) saves building it again.
export function tollMonths(cv, docs, years, { start, months, hours = 2, round_trip = 0.85, cycles = 1.0, today, mw = 0.0, impact = 0.0,
  fee = 0.0, options = CYCLE_OPTIONS, free = true, plan: given = null }) {
  const P = given || tollPlan(cv, docs, years, { start, months, today });
  const { tenor, days: plan, ys, yRef } = P;
  const sized = mw > 0 && impact > 0;
  const cache = new Map();
  // Map "contract year|curve or history year" -> { src, items: steps best first, days }; `own`: with the
  // project's impact; `fees`: paying the grid fee. The slow part: kept with the plan, so other cycle
  // limits come free.
  const ranked = (own, fees = true) => {
    const f = fees ? fee : 0.0;
    const key = `${hours}|${round_trip}|${own && sized ? `${mw}|${impact}` : "taker"}|${f}`;
    if (!poolCache.has(P)) poolCache.set(P, new Map());
    const memo = poolCache.get(P);
    if (memo.has(key)) { const hit = memo.get(key); memo.delete(key); memo.set(key, hit); return hit; }
    const pools = rankPools(own, f);
    memo.set(key, pools);
    if (memo.size > POOLS_KEPT) memo.delete(memo.keys().next().value);
    return pools;
  };
  const rankPools = (own, f) => {
    const pools = new Map();
    plan.forEach(([cdays, ndays, scen], k) => {
      const mo = tenor[k], d = own && sized ? impact * Math.max(mo.base, 0.0) * mw / 1000.0 : 0.0, c = Math.floor(k / 12);
      const ck = `${c}|curve`;
      if (!pools.has(ck)) pools.set(ck, { c, src: "curve", items: [], days: 0 });
      const pc = pools.get(ck);
      for (const [p, cnt, pk] of cdays) {
        const key = `${pk}|${d}|${f}`;
        if (!cache.has(key)) cache.set(key, daySteps(batteryCurve(p, hours, round_trip, d, DAILY_MAX, f)));
        for (const [q, v] of cache.get(key)) pc.items.push([v / q, q * cnt, v * cnt, k]);
      }
      pc.days += ndays;
      for (const [y, [ds, covered]] of scen) {
        const yk = `${c}|${y}`;
        if (!pools.has(yk)) pools.set(yk, { c, src: y, items: [], days: 0 });
        const py = pools.get(yk);
        for (const [p, w] of ds) for (const [q, v] of daySteps(batteryCurve(p, hours, round_trip, d, DAILY_MAX, f))) py.items.push([v / q, q * w, v * w, k]);
        py.days += covered;
      }
    });
    for (const pool of pools.values()) pool.items.sort((a, b) => b[0] - a[0]);
    return pools;
  };
  // per month: intrinsic, each scenario and their mean; the shadow price (mean over scenario-years) and cycles a day used
  const values = (pools, budget) => {
    const got = plan.map(() => new Map()), shadow = [];
    let mwh = 0.0, daysUsed = 0;
    for (const { src, items, days } of pools.values()) {
      const [g, lam] = spend(items, budget * hours * days);
      if (src !== "curve") {
        shadow.push(lam);
        let sub = 0.0;
        for (const v of g.values()) sub += v[1];
        mwh += sub;
        daysUsed += days;
      }
      for (const [k, v] of g) got[k].set(src, v[0]);
    }
    const out = plan.map(([, , scen], k) => {
      const intr = got[k].has("curve") ? got[k].get("curve") : 0.0, sc = new Map();
      for (const y of scen.keys()) sc.set(y, got[k].has(y) ? got[k].get(y) : 0.0);
      return { intrinsic: intr, scen: sc, spot: sc.size ? sum([...sc.values()]) / sc.size : intr };
    });
    return [out, shadow.length ? sum(shadow) / shadow.length : 0.0, daysUsed ? mwh / daysUsed / hours : null];
  };
  const at = ranked(true);
  const [main, shadow, used] = values(at, cycles);
  // the bridge's starting points: a price-taker paying the fee, and one without it
  const taker = sized && free ? values(ranked(false), cycles)[0] : main;
  const bare = fee && free ? values(ranked(false, false), cycles)[0] : taker;
  const opts = options.map((c) => values(at, c));
  const rows = main.map((r, k) => ({ month: tenor[k].month, k, year: ymd(tenor[k].month).y, ...r,
    free: { intrinsic: bare[k].intrinsic, spot: bare[k].spot }, taker: { intrinsic: taker[k].intrinsic, spot: taker[k].spot },
    options: opts.map((o) => [o[0][k].intrinsic, o[0][k].spot]) }));
  return { start, months, hours, cycles, mw, impact, fee, rows, ys, yRef, shadow, cyclesPerDay: used,
    options: options.map((c, j) => ({ cycles: c, cycles_per_day: opts[j][2] })) };
}

// The toll in EUR per MW per year.
export function tollValue(tm, { availability = 0.97, degradation = 0.02, realism = 0.7, other = 0, trend = 0, risk = 0.1,
  margin = 0.05, discount = 0, today }) {
  const { ys, yRef, months } = tm;
  const rows = tm.rows.map((r) => ({ ...r, df: (1 + discount) ** -tau(r.month, today),
    adj: availability * (1 - degradation) ** Math.floor(r.k / 12) * (1 + trend) ** (r.year - yRef) }));
  const wdf = sum(rows.map((r) => r.df));
  const lev = (xs) => 12 * sum(rows.map((r, i) => r.df * xs[i])) / wdf;
  const real = (i, s) => i + realism * (s - i);
  const a0 = lev(rows.map((r) => r.free.intrinsic)), a1 = lev(rows.map((r) => r.free.spot));
  const a2 = a0 + realism * (a1 - a0);
  const f0 = lev(rows.map((r) => r.taker.intrinsic)), f1 = lev(rows.map((r) => r.taker.spot));   // paying the grid fee
  const f2 = f0 + realism * (f1 - f0);
  const b0 = lev(rows.map((r) => r.intrinsic)), b1 = lev(rows.map((r) => r.spot));   // the project's own size
  const b2 = b0 + realism * (b1 - b0), a3 = availability * b2;
  const a4 = lev(rows.map((r) => real(r.intrinsic, r.spot) * availability * (1 - degradation) ** Math.floor(r.k / 12)));
  const a5 = lev(rows.map((r) => real(r.intrinsic, r.spot) * r.adj));
  const a6 = a5 + other, a7 = a6 * (1 - risk), a8 = a7 * (1 - margin);
  const steps = [
    { key: "intrinsic", label: "Intrinsic: the curve's daily shape", value: a0, total: true },
    { key: "extrinsic", label: "Extrinsic: history's daily swings", value: a1 - a0 },
    { key: "realism", label: "Extrinsic you won't capture", value: a2 - a1 },
    { key: "fee", label: "Grid fee on charging", value: f2 - a2 },
    { key: "impact", label: "Own price impact", value: b2 - f2 },
    { key: "availability", label: "Availability", value: a3 - b2 },
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
      net: sum(rs.map((r) => real(r.intrinsic, r.spot) * r.adj)) + other * rs.length / 12 });
  }
  const scenarios = ys.filter((y) => rows.some((r) => r.scen.has(y)))
    .map((y) => ({ year: y, value: lev(rows.map((r) => real(r.intrinsic, r.scen.has(y) ? r.scen.get(y) : r.spot) * r.adj)) + other,
      months: rows.filter((r) => r.scen.has(y)).length }));
  const byCycles = tm.options.map((o, j) => {
    const v = lev(rows.map((r) => real(r.options[j][0], r.options[j][1]) * r.adj)) + other;
    return { cycles: o.cycles, value: v, offer: v * (1 - risk) * (1 - margin), cycles_per_day: o.cycles_per_day };
  });
  const missing = rows.filter((r) => !r.scen.size).length;
  const notes = missing ? [`${missing} of ${rows.length} months have no complete history days in the chosen years: they use the intrinsic value.`] : [];
  return { start: tm.start, months, steps, offer: a8, value: a6, spot: a1, intrinsic: a0, cycles: tm.cycles, mw: tm.mw, fee: tm.fee ?? 0, shadow: tm.shadow,
    cycles_per_day: tm.cyclesPerDay, years: yearsOut, scenarios, by_cycles: byCycles, y_ref: yRef, notes };
}

// The toll as the project grows: [{ mw, value (before risk and margin), offer }], EUR per MW a year.
export function tollSizes(cv, docs, years, o) {
  const plan = o.plan || tollPlan(cv, docs, years, o);
  return o.sizes.map((mw) => {
    const v = tollValue(tollMonths(cv, docs, years, { ...o, mw, options: [], free: false, plan }), o);
    return { mw, value: v.value, offer: v.offer };
  });
}

// ------------------------------------------------------------------ a battery priced off your own figure
// Public data can't see what a battery earns in intraday and balancing, so a toll can also start from
// what you expect it to earn in one year, all in. Each later calendar year earns that times the curve's
// index against the year (its average price, what its curve is worth to a battery on day-ahead with the
// same shapes, or nothing), then your view of cannibalization takes its share. History gives the months
// that have happened, the curve the rest.
export const ANCHOR_INDEX = ["level", "spreads", "flat"];
export const CANNIBAL_RATES = [0.0, 0.05, 0.10, 0.15, 0.20, 0.30];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// What's left in calendar year y of the revenue the curve gives: down `rate` a year from `year`, at most `cap` in all.
export const cannibalFactor = (y, year, rate, cap) => Math.max(1.0 - cap, (1.0 - rate) ** Math.max(y - year, 0));

// The months of a calendar year with a price level: [month, base, peak, "history" | "curve"].
export function yearMonths(cv, stats, year) {
  const hist = stats && stats.years ? stats.years[String(year)] : null;
  const by = new Map(cv.months.map((m) => [m.month, m]));
  const out = [];
  for (let mo = 1; mo <= 12; mo++) {
    const m = dayNum(year, mo, 1), b = hist ? hist.monthly.base[mo - 1] : null;
    if (b != null) out.push([m, b, hist.monthly.peak[mo - 1], "history"]);
    else if (by.has(m)) out.push([m, by.get(m).base, by.get(m).peak, "curve"]);
  }
  return out;
}
function yearLevel(ym) {
  let num = 0.0, den = 0.0;
  for (const [m, b] of ym) { const h = (addMonths(m, 1) - m) * 24; num += b * h; den += h; }
  return den ? num / den : null;
}
// What a battery earns on day-ahead per day, on a curve built from those months' base and peak with your shapes.
function dayValue(cv, stats, years, mode, ym, hours, roundTrip, cycles, fee) {
  if (!ym.length) return null;
  const quotes = ym.map(([m, b, p]) => { const { y, m: mm } = ymd(m); return { product: `${MON[mm - 1]}${String(y % 100).padStart(2, "0")}`, base: b, peak: p ?? null }; });
  const yc = build(quotes, cv.market.code, stats, years, mode), idx = monthIndex(yc);
  let tot = 0.0, n = 0;
  for (const [m] of ym) for (const [p, cnt] of curveDays(yc, idx.get(m) || [])) { tot += cnt * batteryDp(p, hours, roundTrip, cycles, 0.0, fee)[0]; n += cnt; }
  return n ? tot / n : null;
}

// The tenor priced off your figure: `revenue` (EUR per MW, all in) earned in `year`, moved to each later
// calendar year by the curve's index (`index`). Per month: the revenue before cannibalization,
// availability and degradation (a twelfth of the year's).
export function anchor(cv, stats, years, mode, { start, months, revenue, year, index = "level", hours = 2, round_trip = 0.85, cycles = 1.0, fee = 0.0, today }) {
  check(cv, start, today);
  if (!ANCHOR_INDEX.includes(index)) throw new Error(`index must be one of ${ANCHOR_INDEX.join(", ")}`);
  const tenor = tenorMonths(cv, start, months);
  const cal = [...new Set(tenor.map((mo) => ymd(mo.month).y))].sort((a, b) => a - b);
  const refMonths = yearMonths(cv, stats, year);
  if (index !== "flat" && !refMonths.length) throw new Error(`no prices for ${year}: neither history nor the curve has any month of it`);
  const value = (ym) => (index === "level" ? yearLevel(ym) : dayValue(cv, stats, years, mode, ym, hours, round_trip, cycles, fee));
  const ref = index === "flat" ? null : value(refMonths);
  if (index !== "flat" && !(ref && ref > 0)) throw new Error(`${year}'s ${index === "level" ? "price level" : "day-ahead spreads"} came out at nothing: the curve can't scale from it`);
  const byYear = {};
  for (const y of cal) {
    const v = index === "flat" ? null : y === year ? ref : value(yearMonths(cv, stats, y));
    byYear[y] = { value: v, index: index === "flat" ? 1.0 : v / ref };
  }
  const rows = tenor.map((mo, k) => { const y = ymd(mo.month).y; return { month: mo.month, k, year: y, base: revenue * byYear[y].index / 12.0 }; });
  return { start, months, revenue, year, index, ref, ref_months: refMonths.map(([m, , , src]) => [m, src]), by_year: byYear, rows };
}

// The toll in EUR per MW a year from `anchor`: your figure -> following the curve -> cannibalization ->
// availability -> degradation -> risk -> margin, levelized like the toll; with the offer for each rate.
export function anchorValue(am, { cannibal = 0.0, cap = 1.0, availability = 0.97, degradation = 0.02, risk = 0.1, margin = 0.05, discount = 0.0,
  today, rates = CANNIBAL_RATES }) {
  const { rows, year, revenue } = am;
  const df = rows.map((r) => (1 + discount) ** -tau(r.month, today)), wdf = sum(df);
  const lev = (xs) => 12 * sum(xs.map((x, i) => df[i] * x)) / wdf;
  const deg = rows.map((r) => (1 - degradation) ** Math.floor(r.k / 12)), base = rows.map((r) => r.base);
  const path = (rate) => rows.map((r) => r.base * cannibalFactor(r.year, year, rate, cap));
  const net = (xs) => xs.map((x, i) => x * availability * deg[i]);
  const own = path(cannibal);
  const s1 = lev(base), s2 = lev(own), s3 = availability * s2, s4 = lev(net(own)), s5 = s4 * (1 - risk), s6 = s5 * (1 - margin);
  const steps = [
    { key: "figure", label: `Your ${year} figure`, value: revenue, total: true },
    { key: "curve", label: "Following the forward curve", value: s1 - revenue },
    { key: "cannibal", label: "Cannibalization (your view)", value: s2 - s1 },
    { key: "availability", label: "Availability", value: s3 - s2 },
    { key: "degradation", label: "Degradation", value: s4 - s3 },
    { key: "risk", label: "Risk premium", value: s5 - s4 },
    { key: "margin", label: "Margin", value: s6 - s5 },
    { key: "offer", label: "Toll offer", value: s6, total: true },
  ];
  const yearsOut = [];
  for (let k = 0; k < Math.ceil(am.months / 12); k++) {
    const ix = rows.map((r, i) => i).filter((i) => Math.floor(rows[i].k / 12) === k);
    yearsOut.push({ from: rows[ix[0]].month, months: ix.length,
      index: sum(ix.map((i) => am.by_year[rows[i].year].index)) / ix.length,
      cannibal: sum(ix.map((i) => cannibalFactor(rows[i].year, year, cannibal, cap))) / ix.length,
      curve: sum(ix.map((i) => base[i])), own: sum(ix.map((i) => own[i])), expected: sum(ix.map((i) => own[i] * availability * deg[i])) });
  }
  const calendar = [{ year, index: 1.0, curve: revenue, own: revenue }];
  for (const y of Object.keys(am.by_year).map(Number).sort((a, b) => a - b)) {
    if (y === year) continue;
    const i = am.by_year[y].index;
    calendar.push({ year: y, index: i, curve: revenue * i, own: revenue * i * cannibalFactor(y, year, cannibal, cap) });
  }
  const byRate = rates.map((c) => { const v = lev(net(path(c))); return { rate: c, value: v, offer: v * (1 - risk) * (1 - margin) }; });
  return { start: am.start, months: am.months, year, revenue, index: am.index, steps, offer: s6, value: s4, years: yearsOut, calendar, by_rate: byRate,
    cannibal, cap };
}

// The anchored revenue in the shape floorValue takes (availability and degradation are floorValue's own).
export function anchorTm(am, { cannibal = 0.0, cap = 1.0 } = {}) {
  const rows = am.rows.map((r) => { const v = r.base * cannibalFactor(r.year, am.year, cannibal, cap); return { month: r.month, k: r.k, year: r.year, intrinsic: v, spot: v, scen: new Map() }; });
  return { start: am.start, months: am.months, rows, ys: [], yRef: am.year };
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
