// node --test tests/rfq.test.mjs
// rfq.js must agree with PowerDesk's Python RfQ engine on every fixture case (synthetic history).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tenorCurve, ppa, toll, batteryDp, historyMonths } from "../rfq.js";
import { parseIso, isoDate } from "../calendar.js";

const fx = JSON.parse(readFileSync(new URL("./rfq-fixture.json", import.meta.url)));
const close = (a, b, where, tol = 1e-8) => {
  if (a == null || b == null) return assert.equal(a ?? null, b ?? null, where);
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${where}: ${a} vs ${b}`);
};
const docs = Object.fromEntries(Object.entries(fx.docs).map(([y, d]) => [Number(y), d]));
const today = parseIso(fx.today);
const ARGS = { yield_mwh: "yield_mwh", round_trip: "round_trip" };

for (const cs of fx.cases) {
  test(cs.name, () => {
    const start = parseIso(cs.start);
    const { cv, assumed } = tenorCurve(fx.quotes, "DE", fx.stats, fx.years, cs.mode, start, cs.months, cs.growth);
    assert.equal(cv.months.length, cs.curve_months);
    assert.equal(assumed.length, cs.assumed.length);
    assumed.forEach((q, i) => { assert.equal(q.product, cs.assumed[i].product); close(q.base, cs.assumed[i].base, `assumed ${q.product}`); });
    const o = { ...Object.fromEntries(Object.entries(cs.args).map(([k, v]) => [ARGS[k] || k, v])), start, months: cs.months, today };
    const r = cs.kind === "ppa" ? ppa(cv, docs, fx.stats, fx.years, o) : toll(cv, docs, fx.years, o);
    const e = cs.result;
    assert.deepEqual(r.steps.map((s) => s.key), e.steps.map((s) => s.key));
    r.steps.forEach((s, i) => { close(s.value, e.steps[i].value, `step ${s.key}`); assert.equal(s.label, e.steps[i].label); assert.equal(!!s.total, !!e.steps[i].total); });
    close(r.offer, e.offer, "offer");
    close(r.y_ref, e.y_ref, "y_ref");
    assert.deepEqual(r.notes, e.notes);
    assert.deepEqual(r.scenarios.map((s) => [s.year, s.months]), e.scenarios.map((s) => [s.year, s.months]));
    r.scenarios.forEach((s, i) => close(cs.kind === "ppa" ? s.fair : s.value, cs.kind === "ppa" ? e.scenarios[i].fair : e.scenarios[i].value, `scenario ${s.year}`));
    assert.equal(r.years.length, e.years.length);
    if (cs.kind === "ppa") {
      close(r.fair, e.fair, "fair"); close(r.volume, e.volume, "volume"); close(r.curtailed, e.curtailed, "curtailed");
      r.years.forEach((y, i) => { for (const k of ["year", "months", "base", "rate_curve", "rate", "rate_min", "rate_max", "fair"]) close(y[k], e.years[i][k], `year ${y.year} ${k}`); });
    } else {
      close(r.spot, e.spot, "spot"); close(r.intrinsic, e.intrinsic, "intrinsic"); close(r.cycles_per_day, e.cycles_per_day, "cycles");
      r.years.forEach((y, i) => {
        assert.equal(isoDate(y.from), e.years[i].from);
        for (const k of ["months", "intrinsic", "spot", "spot_min", "spot_max", "net"]) close(y[k], e.years[i][k], `year ${e.years[i].from} ${k}`);
      });
    }
  });
}

test("battery dispatch", () => {
  for (const b of fx.battery) {
    const [v, used] = batteryDp(b.prices, b.hours, 0.85, b.cycles);
    close(v, b.out[0], `battery ${b.hours}h x${b.cycles}`, 1e-12);
    assert.equal(used, b.out[1]);
  }
});

test("history by month, with local hours", () => {
  const hm = historyMonths(docs, "DE", "solar").get(fx.history.key);
  assert.equal(hm.days.length, fx.history.days);
  close(hm.mean, fx.history.mean, "mean", 1e-12);
  assert.deepEqual(hm.days.map((d) => d.daytype), fx.history.daytypes);
  assert.deepEqual(hm.days[0].gen.slice(0, 24), fx.history.gen0);
});
