// node --test tests/curve.test.mjs
// curve.js must agree with PowerDesk's Python curve engine on every fixture case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build, genProfile, seasonalPrior, monthHours, batteryDay } from "../curve.js";
import { parse, dayNum, getMarket } from "../calendar.js";

const fx = JSON.parse(readFileSync(new URL("./curve-fixture.json", import.meta.url)));
const close = (a, b, where, tol = 1e-8) => {
  if (a == null || b == null) return assert.equal(a ?? null, b ?? null, where);
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${where}: ${a} vs ${b}`);
};
const closeObj = (a, b, where) => { for (const k of Object.keys(b)) close(a[k], b[k], `${where}.${k}`); };

for (const [i, cs] of fx.cases.entries()) {
  test(`case ${i}: ${cs.quotes.map((q) => q.product).join(", ")} (${cs.market}, ${cs.mode})`, () => {
    const stats = cs.years.length ? fx.stats : null;
    const cv = build(cs.quotes, cs.market, stats, cs.years, cs.mode);
    assert.equal(cv.months.length, cs.months.length);
    cs.months.forEach((m, k) => {
      const g = cv.months[k];
      assert.equal(g.label, m.label);
      closeObj(g, { base: m.base, peak: m.peak, offpeak: m.offpeak }, `month ${m.label}`);
      assert.deepEqual(g.quoted, m.quoted);
      assert.equal(g.constrained, m.constrained);
    });
    assert.equal(cv.checks.length, cs.checks.length);
    cs.checks.forEach((c, k) => { assert.equal(cv.checks[k].label, c.label); close(cv.checks[k].implied, c.implied, "check"); });
    close(cv.level, cs.level, "level");
    assert.equal(cv.t.length, cs.n);
    assert.equal(cv.t[0], cs.t0);
    close(cv.price.reduce((a, b) => a + b, 0), cs.sum, "sum", 1e-9);
    for (const [j, t, h, pk, p] of cs.sample) {
      assert.equal(cv.t[j], t); assert.equal(cv.hour[j], h); assert.equal(cv.peak[j], pk); close(cv.price[j], p, `hour ${j}`);
    }
    const solar = stats ? genProfile(stats, cs.years, "solar") : null;
    const wind = stats ? genProfile(stats, cs.years, "wind") : null;
    for (const [p, v] of Object.entries(cs.products)) closeObj(cv.product(parse(p, 0)), v, `product ${p}`);
    for (const [p, v] of Object.entries(cs.blocks)) closeObj(cv.block(parse(p, 0), new Set([0, 1, 2, 3, 4]), 17, 21), v, `block ${p}`);
    for (const [p, v] of Object.entries(cs.capture)) {
      if (v.solar) closeObj(cv.capture(parse(p, 0), solar), v.solar, `solar ${p}`);
      if (v.wind) closeObj(cv.capture(parse(p, 0), wind), v.wind, `wind ${p}`);
    }
    for (const [p, v] of Object.entries(cs.battery)) closeObj(cv.battery(parse(p, 0), 2, 0.85), v, `battery ${p}`);
    const pr = seasonalPrior(stats, cs.years);
    for (const k of ["rho", "pi", "omega"]) pr[k].forEach((v, m) => close(v, cs.prior[k][m], `prior ${k}${m}`));
  });
}

test("clock-change days and the battery", () => {
  const de = getMarket("DE");
  const oct = monthHours(dayNum(2026, 10, 1), de).filter((r) => r[1] === dayNum(2026, 10, 25)).map((r) => r[2]);
  assert.deepEqual(oct.slice(0, 5), [0, 1, 2, 2, 3]);
  assert.equal(oct.length, 25);
  const s = Math.sqrt(0.85);
  close(batteryDay([20, 20, 100, 100], 1), 100 * s - 20 / s, "battery");
  assert.equal(batteryDay([5, 4, 3, 2], 1), 0);
});
