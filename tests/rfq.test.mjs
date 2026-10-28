// node --test tests/rfq.test.mjs
// rfq.js must agree with PowerDesk's Python RfQ engine on every fixture case (synthetic history).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tenorCurve, ppa, toll, tollMonths, tollSizes, floorValue, batteryDp, batteryCurve, daySteps, historyMonths } from "../rfq.js";
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
      close(r.value, e.value, "value"); close(r.shadow, e.shadow, "shadow");
      assert.equal(r.by_cycles.length, e.by_cycles.length);
      r.by_cycles.forEach((b, i) => { for (const k of ["cycles", "value", "offer", "cycles_per_day"]) close(b[k], e.by_cycles[i][k], `${b.cycles} cycles ${k}`); });
      r.years.forEach((y, i) => {
        assert.equal(isoDate(y.from), e.years[i].from);
        for (const k of ["months", "intrinsic", "spot", "spot_min", "spot_max", "net"]) close(y[k], e.years[i][k], `year ${e.years[i].from} ${k}`);
      });
      // the same battery under a revenue floor
      const tech = { hours: o.hours, round_trip: o.round_trip, cycles: o.cycles, mw: o.mw, impact: o.impact, fee: o.fee };
      Object.keys(tech).forEach((k) => tech[k] === undefined && delete tech[k]);
      const tm = tollMonths(cv, docs, fx.years, { start, months: cs.months, today, ...tech });
      for (const fl of cs.floors) {
        const f = floorValue(tm, { ...fl.args, today }), g = fl.result;
        for (const k of ["expected", "level", "cap_level", "fair_fee", "fee", "share_fair", "share", "chance", "pv_put", "pv_call"]) close(f[k], g[k], `floor ${k}`);
        assert.equal(f.years.length, g.years.length);
        f.years.forEach((y, i) => {
          assert.equal(isoDate(y.from), g.years[i].from);
          for (const k of ["months", "expected", "floor", "sd", "chance", "payout", "df", "pv_put", "pv_call"]) close(y[k], g.years[i][k], `floor year ${g.years[i].from} ${k}`);
        });
      }
    }
  });
}

test("battery dispatch, revenue by MWh and its steps", () => {
  for (const b of fx.battery) {
    const where = `battery ${b.hours}h x${b.cycles} impact ${b.impact} fee ${b.fee}`;
    const [v, used] = batteryDp(b.prices, b.hours, 0.85, b.cycles, b.impact, b.fee);
    close(v, b.out[0], where, 1e-12);
    assert.equal(used, b.out[1]);
    const c = batteryCurve(b.prices, b.hours, 0.85, b.impact, undefined, b.fee);
    assert.equal(c.length, b.curve.length);
    c.forEach((x, q) => (b.curve[q] == null ? assert.equal(x, -Infinity) : close(x, b.curve[q], `${where} q=${q}`, 1e-12)));
    const st = daySteps(c);
    assert.equal(st.length, b.steps.length, where);
    st.forEach(([q, x], i) => { assert.equal(q, b.steps[i][0]); close(x, b.steps[i][1], `${where} step ${i}`, 1e-12); });
  }
});

test("the toll as the battery grows, with and without a grid fee", () => {
  const offers = fx.sizes.map((sz) => {
    const a = sz.args, start = parseIso(a.start);
    const { cv } = tenorCurve(fx.quotes, "DE", fx.stats, fx.years, "multiplicative", start, a.months, 0.0);
    const r = tollSizes(cv, docs, fx.years, { ...a, start, today });
    assert.equal(r.length, sz.result.length);
    r.forEach((x, i) => { assert.equal(x.mw, sz.result[i].mw); close(x.value, sz.result[i].value, `value ${x.mw}`); close(x.offer, sz.result[i].offer, `offer ${x.mw}`); });
    for (let i = 1; i < r.length; i++) assert.ok(r[i].offer < r[i - 1].offer, "a bigger battery earns less per MW");
    return r.map((x) => x.offer);
  });
  offers[1].forEach((o, i) => assert.ok(o < offers[0][i], "the fee costs something at every size"));
});

test("the grid fee's bridge step", () => {
  const cs = fx.cases.find((c) => c.name.includes("a grid fee on charging"));
  const start = parseIso(cs.start);
  const { cv } = tenorCurve(fx.quotes, "DE", fx.stats, fx.years, cs.mode, start, cs.months, cs.growth);
  const o = { ...cs.args, start, months: cs.months, today };
  const withFee = toll(cv, docs, fx.years, o), without = toll(cv, docs, fx.years, { ...o, fee: 0 });
  const step = (r, k) => r.steps.find((s) => s.key === k).value;
  assert.ok(step(withFee, "fee") < 0);
  assert.equal(step(without, "fee"), 0);
  assert.equal(withFee.intrinsic, without.intrinsic);              // the bridge starts without it
  assert.equal(withFee.spot, without.spot);
  // after the fee, everything is as if the battery had been worth that much less from the start
  close(step(withFee, "realism"), step(without, "realism"), "realism");
  assert.ok(step(withFee, "availability") > step(without, "availability"));   // a smaller loss on a smaller value
  assert.ok(withFee.offer < without.offer);
  assert.ok(withFee.cycles_per_day <= without.cycles_per_day + 1e-9, "it drops the thinnest spreads");
});

test("history by month, with local hours", () => {
  const hm = historyMonths(docs, "DE", "solar").get(fx.history.key);
  assert.equal(hm.days.length, fx.history.days);
  close(hm.mean, fx.history.mean, "mean", 1e-12);
  assert.deepEqual(hm.days.map((d) => d.daytype), fx.history.daytypes);
  assert.deepEqual(hm.days[0].gen.slice(0, 24), fx.history.gen0);
});
