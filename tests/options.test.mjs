// node --test tests/options.test.mjs
// options.js must agree with PowerDesk's Python pricers: closed forms to 1e-9,
// Monte Carlo statistically.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as o from "../options.js";

const fixture = JSON.parse(readFileSync(new URL("./options-fixture.json", import.meta.url)));
const close = (a, b, where) => {
  const tol = 1e-9 * Math.max(1, Math.abs(b));
  assert.ok(Math.abs(a - b) <= tol, `${where}: ${a} vs ${b}`);
};
const model = ([ss, hl, sl, rho]) => o.TwoFactor.fromHalfLife(ss, hl, sl, rho);

test(`closed forms match the Python reference on ${fixture.length} cases`, () => {
  for (const c of fixture) {
    const where = `${c.fn}(${JSON.stringify(c.args).slice(0, 80)})`;
    let got;
    if (c.fn === "forwardVol") got = model(c.args[0]).forwardVol(c.args[1]);
    else if (c.fn === "logCov") got = model(c.args[0]).logCov(...c.args.slice(1));
    else if (c.fn === "monthOptions") got = o.monthOptions(model(c.args[0]), ...c.args.slice(1));
    else got = o[c.fn](...c.args);
    if (typeof c.out === "number") close(got, c.out, where);
    else for (const k of Object.keys(c.out)) close(got[k], c.out[k], `${where}.${k}`);
  }
});

test("Monte Carlo agrees with the closed forms", () => {
  const m = o.TwoFactor.fromHalfLife(1.2, 5, 0.35, 0);
  const res = o.monthOptions(m, 90, 100, 30 / 365, 31, 28 / 365);
  const mc = o.asianMc(res.forwards, res.fixingCov, 100, res.end, 0, "call", 40000, 3);
  assert.ok(Math.abs(mc.price - res.asian) < 4 * mc.stderr + 0.01 * res.asian, `${mc.price} vs ${res.asian}`);
  assert.ok(mc.stderr < mc.plainStderr / 5, "control variate should cut the error");
  const k = o.kirk(95, 66.5, 27.9, 30 / 365, 0.45, 0.5, 0.8);
  const sm = o.spreadMc(95, 66.5, 27.9, 30 / 365, 0.45, 0.5, 0.8, 0, "call", 200000, 9);
  assert.ok(Math.abs(sm.price - k) < 4 * sm.stderr + 0.02 * k, `${sm.price} vs ${k}`);
});

test("identities", () => {
  const c = o.black76(85, 90, 0.25, 0.4, 0.03, "call"), p = o.black76(85, 90, 0.25, 0.4, 0.03, "put");
  close(c - p, Math.exp(-0.03 * 0.25) * (85 - 90), "parity");
  close(o.kirk(95, 70, 0, 0.5, 0.45, 0.5, 0.8), o.margrabe(95, 70, 0.5, 0.45, 0.5, 0.8), "kirk at K=0");
  assert.ok(Math.abs(o.N(0) - 0.5) < 1e-16 && Math.abs(o.N(1.96) - 0.9750021048517795) < 1e-15);
  assert.throws(() => o.black76Iv(0.5, 85, 60, 0.25));
});
