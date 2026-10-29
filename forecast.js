// forecast.js — the Forecast tab's arithmetic, on PowerDesk's live day-ahead forecast for Hungary
// (powerdesk/epf.py, which writes epf/live/HU/summary.json to the data branch): where a delivery
// day stands, its numbers, a forecast's errors as PowerDesk scores them, and the record so far.
import { parseIso, weekday, isoDate, todayIn, zonedToUtc } from "./calendar.js";

export const ZONE = "HU";
export const TZ = "Europe/Budapest";
export const MODELS = ["lear", "lear_hu", "lear_nores", "fr", "naive"];      // PowerDesk's names, best first
export const MODEL_NAME = { lear: "LEAR", lear_hu: "LEAR on Hungary's inputs", lear_nores: "LEAR without wind and solar",
  fr: "Residual-load regression", naive: "Naive" };
// The delivery day's inputs PowerDesk flags as out or not when it forecasts.
export const INPUTS = [
  { key: "load", zone: "HU", what: "load" }, { key: "wind", zone: "HU", what: "wind" }, { key: "solar", zone: "HU", what: "solar" },
  { key: "load_de", zone: "DE", what: "load" }, { key: "wind_de", zone: "DE", what: "wind" }, { key: "solar_de", zone: "DE", what: "solar" },
];
// epf-live.yml's schedule, Budapest time: two forecasts before the noon auction, two runs to score it.
export const RUNS = [[10, 17], [11, 41], [13, 47], [18, 17]];

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

/** Which of the delivery day's inputs were out when the forecast was made, by zone:
 *  { out: { HU: ["load", …], DE: […] }, missing: { HU: […], DE: […] } }. */
export function inputsByZone(inputs) {
  const out = { HU: [], DE: [] }, missing = { HU: [], DE: [] };
  for (const x of INPUTS) (inputs && inputs[x.key] ? out : missing)[x.zone].push(x.what);
  return { out, missing };
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
