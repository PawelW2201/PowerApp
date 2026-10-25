// node --test tests/
// The JS calendar must agree with PowerDesk's Python reference on every fixture case,
// and on a few hand-computed values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { delivery, parse, parseIso, isoDate, easterSunday, polishHolidays, strip, weekday, dayNum } from "../calendar.js";

const fixture = JSON.parse(readFileSync(new URL("./products-fixture.json", import.meta.url)));

test(`matches the Python reference on ${fixture.length} cases`, () => {
  let checked = 0;
  for (const c of fixture) {
    const asof = parseIso(c.asof);
    const where = `${c.code} ${c.market} as of ${c.asof}`;
    if (c.error) {
      assert.throws(() => delivery(c.code, c.market, asof), undefined, where);
      continue;
    }
    const d = delivery(c.code, c.market, asof);
    assert.equal(d.period.label, c.label, where);
    assert.equal(d.period.kind, c.kind, where);
    assert.equal(isoDate(d.period.start), c.first_day, where);
    assert.equal(isoDate(d.period.lastDay), c.last_day, where);
    assert.equal(d.startUtc, c.start_utc_ms, where);
    assert.equal(d.endUtc, c.end_utc_ms, where);
    assert.deepEqual(d.hours, c.hours, where);
    checked++;
  }
  assert.ok(checked > 900, `only ${checked} cases checked`);
});

test("hand-computed values", () => {
  assert.deepEqual(delivery("Cal27", "DE").hours, { base: 8760, peak: 3132, offpeak: 5628 });
  assert.equal(delivery("Cal27", "PL").hours.peak, 253 * 15);
  assert.equal(delivery("2026-10-25", "DE").hours.base, 25);
  assert.equal(delivery("2027-03-28", "DE").hours.base, 23);
  assert.equal(delivery("Q1-27", "DE").hours.base, 2159);
});

test("helpers", () => {
  assert.equal(weekday(dayNum(2026, 10, 25)), 6);           // Sunday
  assert.equal(isoDate(easterSunday(2027)), "2027-03-28");
  assert.ok(polishHolidays(2027).has(dayNum(2027, 12, 24)));
  assert.ok(!polishHolidays(2024).has(dayNum(2024, 12, 24)));
  assert.deepEqual(strip(dayNum(2026, 10, 25)),
    ["Nov26", "Dec26", "Jan27", "Q1-27", "Q2-27", "Q3-27", "Q4-27", "Sum27", "Win27", "Cal27", "Cal28", "Cal29"]);
  assert.deepEqual(strip(dayNum(2027, 5, 10)).slice(7, 9), ["Win27", "Sum28"]);
  assert.throws(() => parse("Q5-27", 0));
});
