// node --test tests/intraday.test.mjs
// intraday.js must agree with PowerDesk's Python intraday simulator on every fixture case, day by day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rng, world, battery, simulate, sweep, POLICIES, ncdf } from "../intraday.js";

const fx = JSON.parse(readFileSync(new URL("./intraday-fixture.json", import.meta.url)));
const close = (a, b, where, tol = 1e-9) => {
  if (a == null || b == null) return assert.equal(a ?? null, b ?? null, where);
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${where}: ${a} vs ${b}`);
};
const closeAll = (xs, ys, where, tol) => { assert.equal(xs.length, ys.length, `${where} length`); xs.forEach((x, i) => close(x, ys[i], `${where}[${i}]`, tol)); };

test("the seeded generator matches Python bit for bit", () => {
  const r = rng(fx.rng.seed);
  fx.rng.values.forEach((v, i) => assert.equal(r(), v, `draw ${i}`));
});

test("the normal cdf is sane", () => {
  close(ncdf(0), 0.5, "N(0)", 1e-15);
  close(ncdf(1.96) + ncdf(-1.96), 1, "symmetry", 1e-15);
});

for (const cs of fx.cases) {
  test(cs.name, () => {
    const w = world(fx.day, cs.world), b = battery(cs.battery);
    closeAll(w.drift, cs.drift, "drift levels");
    closeAll(w.jump, cs.jump, "spike sizes");
    closeAll(w.comp, cs.comp, "spike shift");
    closeAll(w.meanId, cs.mean_id, "mean intraday");
    closeAll(w.pd[Math.floor(w.nd / 2)], cs.pd_row, "drift row");
    closeAll(w.ps[20][0], cs.ps_row, "spike row");
    for (const [h, t, x, q] of cs.quotes) close(w.quote(h, t, x), q, `quote ${h} at ${t} in ${x}`);
    const r = simulate(w, b, { days: cs.days, seed: cs.seed });
    assert.deepEqual(r.dayAheadActions, cs.day_ahead_actions);
    close(r.spread.day_ahead, cs.spread.day_ahead, "day-ahead spread");
    close(r.spread.oracle, cs.spread.oracle, "oracle spread");
    for (const name of POLICIES) {
      for (const k of ["expected", "mean", "se", "p10", "p90", "traded"]) close(r.policies[name][k], cs.policies[name][k], `${name} ${k}`);
    }
    if (cs.example) {
      closeAll(r.example.intraday, cs.example.intraday, "example prices");
      closeAll(r.example.spike, cs.example.spike, "example spikes");
      for (const name of POLICIES) {
        assert.deepEqual(Array.from(r.example.actions[name]), cs.example.actions[name], `example ${name} actions`);
        close(r.example.values[name], cs.example.values[name], `example ${name} value`);
      }
    } else assert.equal(r.example, null);
  });
}

test("each policy's value as spikes get more frequent", () => {
  const s = fx.sweep;
  const r = sweep(fx.day, battery(s.battery), { ...s.world, perDays: s.perDays, days: s.days, seed: s.seed });
  assert.equal(r.length, s.result.length);
  r.forEach((row, i) => { for (const k of ["per_day", ...POLICIES]) close(row[k], s.result[i][k], `sweep ${i} ${k}`); });
});
