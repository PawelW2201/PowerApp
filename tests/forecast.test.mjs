// node --test tests/forecast.test.mjs
// forecast.js must read PowerDesk's live forecast summaries as PowerDesk writes them: the fixture is
// made-up days run through powerdesk/epf.py's live cycle (tests/make_epf_fixture.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stage, naiveFrom, dayStats, errors, record, inputsByZone, nextRun, slot, clockAxis, MODELS, MODEL_NAME } from "../forecast.js";

const fx = JSON.parse(readFileSync(new URL("./epf-fixture.json", import.meta.url)));
const run = (name) => fx.runs.find((r) => r.name === name);
const close = (a, b, where, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${where}: ${a} vs ${b}`);

test("the fixture has the live cycle's stages", () => {
  assert.deepEqual(fx.runs.map((r) => r.name), ["first forecast", "no solar yet", "scored", "germany late", "final"]);
  for (const r of fx.runs) for (const m of Object.keys(r.summary.latest.forecasts)) assert.ok(MODELS.includes(m) && MODEL_NAME[m], m);
});

test("errors are PowerDesk's scores, for every model of every scored day", () => {
  let n = 0;
  for (const r of fx.runs) {
    const d = r.summary.last_scored;
    if (!d) continue;
    for (const [m, s] of Object.entries(d.scores)) {
      const e = errors(d.forecasts[m], d.actual);
      close(e.mae, s.mae, `${d.target} ${m} mae`);
      close(e.rmse, s.rmse, `${d.target} ${m} rmse`);
      close(e.bias, s.bias, `${d.target} ${m} bias`);
      assert.equal(e.byHour.length, 24);
      e.byHour.forEach((v, h) => close(v, s.by_hour[h], `${d.target} ${m} hour ${h}`));
      n++;
    }
  }
  assert.ok(n >= 9, `${n} scores checked`);
});

test("the record matches PowerDesk's running totals", () => {
  const s = run("final").summary;
  const r = record(s.days);
  assert.equal(r.days, 4);
  close(r.main, s.totals.main.mae, "main");
  close(r.naive, s.totals.naive.mae, "naive");
  close(r.ratio, s.totals.main.mae / s.totals.naive.mae, "ratio");
  assert.equal(r.model, 3, "a day the naive was the forecast isn't the model's");
  assert.deepEqual(s.days.map((d) => d.main), ["naive", "ens_hu", "ens", "ens"]);
  const wins = s.days.filter((d) => d.main !== "naive" && d.mae[d.main] < d.mae.naive).length;
  assert.equal(r.wins, wins);
  assert.equal(record([]), null);
  assert.equal(record(run("first forecast").summary.days), null);
});

test("stages: open before the auction, closed after it, scored once priced", () => {
  for (const r of fx.runs) {
    const s = r.summary, now = Date.parse(r.now_utc), gate = Date.parse(s.latest.gate_utc);
    assert.equal(stage(s.latest, now), "open", `${r.name}: made before its gate`);
    assert.equal(stage(s.latest, gate - 1), "open");
    assert.equal(stage(s.latest, gate), "closed");
    if (s.last_scored) assert.equal(stage(s.last_scored, now), "scored");
  }
  assert.equal(stage(null, 0), null);
  // the gate is noon in Budapest the day before delivery
  const L = run("first forecast").summary.latest;
  assert.equal(L.gate_utc, "2026-02-21T11:00:00+00:00");
  assert.equal(L.target, "2026-02-22");
});

test("the naive repeats the day naiveFrom names", () => {
  let n = 0;
  for (const r of fx.runs) for (const d of [r.summary.latest, r.summary.last_scored]) {
    if (!d) continue;
    const from = naiveFrom(d.target);
    if (!fx.prices[from.day]) continue;
    assert.deepEqual(d.forecasts.naive, fx.prices[from.day], `${d.target} from ${from.day}`);
    n++;
  }
  assert.ok(n >= 5, `${n} checked`);
  assert.deepEqual(naiveFrom("2026-10-30"), { lag: 1, day: "2026-10-29" });   // Friday: Thursday's
  assert.deepEqual(naiveFrom("2026-10-31"), { lag: 7, day: "2026-10-24" });   // Saturday: last Saturday's
  assert.deepEqual(naiveFrom("2026-11-02"), { lag: 7, day: "2026-10-26" });   // Monday: last Monday's
});

test("which inputs were out, by zone", () => {
  const all = inputsByZone(run("first forecast").summary.latest.inputs);
  assert.deepEqual(all.out, { HU: ["load", "wind", "solar"], DE: ["load", "wind", "solar"] });
  assert.deepEqual(all.missing, { HU: [], DE: [] });
  const dark = inputsByZone(run("no solar yet").summary.latest.inputs);
  assert.equal(run("no solar yet").summary.latest.main, "lear_nores");
  assert.deepEqual(dark.missing, { HU: ["solar"], DE: [] });
  const late = run("germany late").summary.latest;
  assert.equal(late.main, "ens_hu");
  assert.deepEqual(inputsByZone(late.inputs).missing, { HU: [], DE: ["load", "wind", "solar"] });
  const none = inputsByZone(run("final").summary.latest.inputs);
  assert.deepEqual(none.out, { HU: [], DE: [] });
  assert.deepEqual(inputsByZone(undefined).missing.DE, ["load", "wind", "solar"]);
});

test("a day's numbers", () => {
  const v = Array.from({ length: 96 }, (_, i) => (i >= 32 && i < 80 ? 100 : 50));
  v[70] = 300; v[13] = -5;
  const wd = dayStats(v, "2026-10-30");          // a Friday
  close(wd.base, (48 * 100 + 48 * 50 + 200 - 55) / 96, "base");
  close(wd.peak, (48 * 100 + 200) / 48, "peak");
  assert.equal(wd.max, 300); assert.equal(wd.maxAt, "17:30");
  assert.equal(wd.min, -5); assert.equal(wd.minAt, "03:15");
  assert.equal(dayStats(v, "2026-10-31").peak, null, "no peak at the weekend");
});

test("clock labels and the chart's axis", () => {
  assert.equal(slot(0), "00:00"); assert.equal(slot(1), "00:15"); assert.equal(slot(95), "23:45");
  const t = clockAxis("2026-10-25");             // a clock-change day still reads by the clock
  assert.equal(t.length, 96);
  assert.equal(new Date(t[0] * 1000).toISOString(), "2026-10-25T00:00:00.000Z");
  assert.equal(new Date(t[95] * 1000).toISOString(), "2026-10-25T23:45:00.000Z");
});

test("the next scheduled run, Budapest time", () => {
  // 21:39 in Budapest on Wed 28 Oct (CET): the next is 10:17 on Thursday
  let r = nextRun(Date.parse("2026-10-28T20:39:00Z"));
  assert.equal(new Date(r.at).toISOString(), "2026-10-29T09:17:00.000Z");
  // 11:00 in summer (CEST): the 11:41 run
  r = nextRun(Date.parse("2026-06-10T09:00:00Z"));
  assert.equal(new Date(r.at).toISOString(), "2026-06-10T09:41:00.000Z");
  // just after the last run of the day
  r = nextRun(Date.parse("2026-06-10T16:17:30Z"));
  assert.equal(new Date(r.at).toISOString(), "2026-06-11T08:17:00.000Z");
});
