// forecast.js — the Forecast tab's arithmetic, on PowerDesk's live day-ahead forecasts (powerdesk/epf.py,
// which writes epf/live/<zone>/summary.json to the data branch) for Hungary, Germany, Romania,
// Bulgaria and Poland: where a delivery day stands, its numbers, a forecast's errors as PowerDesk scores
// them, the price ranges (powerdesk/bands.py) where a zone has them and how often they held, and the
// record so far.
import { parseIso, weekday, isoDate, todayIn, zonedToUtc } from "./calendar.js";

export const ZONE = "HU";
export const TZ = "Europe/Budapest";             // the auction's and the runs' clock, for every zone
// The markets PowerDesk forecasts live (powerdesk/zones.py), each on its own delivery day's clock.
export const ZONES = {
  HU: { code: "HU", name: "Hungary", of: "Hungary's", tz: "Europe/Budapest", clock: "Budapest" },
  DE: { code: "DE", name: "Germany", of: "Germany's", tz: "Europe/Berlin", clock: "German" },
  RO: { code: "RO", name: "Romania", of: "Romania's", tz: "Europe/Bucharest", clock: "Romanian" },
  BG: { code: "BG", name: "Bulgaria", of: "Bulgaria's", tz: "Europe/Sofia", clock: "Bulgarian" },
  PL: { code: "PL", name: "Poland", of: "Poland's", tz: "Europe/Warsaw", clock: "Polish" },
};
export const ZONE_CODES = ["HU", "DE", "RO", "BG", "PL"];
// PowerDesk's names, best first: a version's main is the first of its zone's list it has.
export const MODELS = ["pool_c", "pool_hu", "gbm", "ens", "ens_hu", "lear", "lear_hu", "lear_nores", "fr", "naive"];
export const MODEL_NAME = { pool_c: "Pool + boosting", pool_hu: "The pool", gbm: "Gradient boosting",
  ens: "LEAR + XGBoost", ens_hu: "LEAR + XGBoost on Hungary's inputs", lear: "LEAR",
  lear_hu: "LEAR on Hungary's inputs", lear_nores: "LEAR without wind and solar", fr: "Residual-load regression", naive: "Naive" };
// The same model with every input: what one run without some of them gives up.
export const FULL = { ens_hu: "ens", lear_hu: "lear", lear_nores: "lear" };
// The delivery day's inputs PowerDesk flags as out or not when it forecasts (epf.inputs_of): the
// zone's own load, wind and solar, and for Hungary Germany's too.
const own = (z) => [{ key: "load", zone: z, what: "load" }, { key: "wind", zone: z, what: "wind" }, { key: "solar", zone: z, what: "solar" }];
export const INPUTS_OF = {
  HU: [...own("HU"), { key: "load_de", zone: "DE", what: "load" }, { key: "wind_de", zone: "DE", what: "wind" }, { key: "solar_de", zone: "DE", what: "solar" }],
  DE: own("DE"), RO: own("RO"), BG: own("BG"), PL: own("PL"),
};
export const INPUTS = INPUTS_OF.HU;
// epf-live.yml's schedule since release 4.1, Budapest time: cron-job.org starts two forecasts before
// the noon auction and one run to score it once its prices are out (GitHub's schedule is a fallback).
export const RUNS = [[10, 5], [11, 20], [16, 0]];
// The price ranges (powerdesk/bands.py), where a zone's forecast has them: each band's quantiles.
export const BANDS = { 50: ["q25", "q75"], 80: ["q10", "q90"], 90: ["q05", "q95"] };

const pad = (x) => String(x).padStart(2, "0");
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** The clock time a quarter-hour of the day starts at: 0 is "00:00", 95 is "23:45". */
export const slot = (i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`;

/** The day's 96 quarter-hours as unix seconds on a UTC-naive axis, for a step chart drawn in
 *  "UTC": PowerDesk keeps every day on the 96 quarter-hours of the clock (a clock-change day
 *  included), so the chart reads by the clock too. */
export const clockAxis = (target) => Array.from({ length: 96 }, (_, i) => parseIso(target) * 86400 + i * 900);

/** Where a delivery day's forecast stands at `now` (ms): "open" while its auction (noon the day
 *  before) takes bids, "closed" once the auction has run but its prices haven't scored it yet,
 *  "scored" after. */
export function stage(doc, now) {
  if (!doc) return null;
  if (doc.actual && doc.scores) return "scored";
  return now < Date.parse(doc.gate_utc) ? "open" : "closed";
}

/** The day the naive forecast repeats: a week back for a Monday, Saturday or Sunday, the day
 *  before otherwise. */
export function naiveFrom(target) {
  const n = parseIso(target), lag = [0, 5, 6].includes(weekday(n)) ? 7 : 1;
  return { lag, day: isoDate(n - lag) };
}

/** A day's numbers from its 96 quarter-hours: base, peak (Mon–Fri 08–20; null at the weekend),
 *  and the low and the high with the quarter-hour each starts at. */
export function dayStats(values, target) {
  const weekend = weekday(parseIso(target)) >= 5;
  let lo = 0, hi = 0;
  values.forEach((v, i) => { if (v < values[lo]) lo = i; if (v > values[hi]) hi = i; });
  return { base: mean(values), peak: weekend ? null : mean(values.slice(32, 80)),
    min: values[lo], minAt: slot(lo), max: values[hi], maxAt: slot(hi) };
}

/** A forecast's errors against the auction's prices (forecast minus price), as PowerDesk scores
 *  them: the mean absolute error, the root mean square, the mean (bias), each hour's mean
 *  absolute error, and the errors themselves. */
export function errors(forecast, actual) {
  const e = forecast.map((f, i) => f - actual[i]);
  const byHour = [];
  for (let h = 0; 4 * h < e.length; h++) byHour.push(mean(e.slice(4 * h, 4 * h + 4).map(Math.abs)));
  return { mae: mean(e.map(Math.abs)), rmse: Math.sqrt(mean(e.map((x) => x * x))), bias: mean(e), byHour, e };
}

/** The record so far from the summary's scored days: the forecast that counted each day (the
 *  main) against the naive, on the days both were scored. `model` counts the days the main was a
 *  model rather than the naive itself, `wins` those it beat the naive on. */
export function record(days) {
  const both = (days || []).filter((d) => d.mae && d.mae[d.main] != null && d.mae.naive != null);
  if (!both.length) return null;
  const main = mean(both.map((d) => d.mae[d.main])), naive = mean(both.map((d) => d.mae.naive));
  const model = both.filter((d) => d.main !== "naive");
  return { days: both.length, main, naive, ratio: naive > 0 ? main / naive : null,
    model: model.length, wins: model.filter((d) => d.mae[d.main] < d.mae.naive).length };
}

/** Which of the delivery day's inputs were out when `zone`'s forecast was made, by the zone they
 *  are of: { out: { HU: ["load", …], DE: […] }, missing: { HU: […], DE: […] } } for Hungary, and
 *  the zone's own alone for the others ({ out: { RO: […] }, missing: { RO: […] } }). */
export function inputsByZone(inputs, zone = ZONE) {
  const list = INPUTS_OF[zone] || INPUTS;
  const zs = [...new Set(list.map((x) => x.zone))];
  const out = Object.fromEntries(zs.map((z) => [z, []])), missing = Object.fromEntries(zs.map((z) => [z, []]));
  for (const x of list) (inputs && inputs[x.key] ? out : missing)[x.zone].push(x.what);
  return { out, missing };
}

/** A price range from a version's quantiles (powerdesk/bands.py): { lo, hi } for the 50, 80 or 90%
 *  band, or null if the version has none. */
export function band(quantiles, level) {
  const [lo, hi] = BANDS[level] || [];
  return quantiles && quantiles[lo] && quantiles[hi] ? { lo: quantiles[lo], hi: quantiles[hi] } : null;
}

/** How a range did on a priced day, as PowerDesk scores it (bands.scores): the share of quarter-
 *  hours whose price fell inside it, ends included, and its mean width. Null without the range. */
export function coverage(quantiles, actual, level) {
  const b = band(quantiles, level);
  if (!b || !actual) return null;
  let inside = 0;
  actual.forEach((y, i) => { if (y >= b.lo[i] && y <= b.hi[i]) inside++; });
  return { share: inside / actual.length, width: mean(b.hi.map((v, i) => v - b.lo[i])) };
}

/** How often the ranges held since they went live: each band's coverage averaged over the scored
 *  days that had ranges (the summary's days[].band), or null before the first. */
export function bandRecord(days) {
  const with80 = (days || []).filter((d) => d.band && d.band["80"] != null);
  if (!with80.length) return null;
  const avg = (lv) => { const xs = with80.map((d) => d.band[lv]).filter((v) => v != null); return xs.length ? mean(xs) : null; };
  return { days: with80.length, 50: avg("50"), 80: avg("80"), 90: avg("90") };
}

/** The next scheduled run after `now` (ms): { at (ms), h, mi, day (day number, Budapest) }. */
export function nextRun(now) {
  const t = todayIn(TZ, now);
  for (const n of [t, t + 1]) for (const [h, mi] of RUNS) {
    const at = zonedToUtc(n, h, TZ) + mi * 60000;
    if (at > now) return { at, h, mi, day: n };
  }
  return null;
}
