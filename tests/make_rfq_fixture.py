"""Make tests/rfq-fixture.json from PowerDesk's Python RfQ engine (the reference), on synthetic
history only: no market data goes into this public repository.

    python tests/make_rfq_fixture.py ../PowerDesk > tests/rfq-fixture.json
"""
import datetime as dt
import json
import math
import random
import sys
from zoneinfo import ZoneInfo

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "../PowerDesk")
from powerdesk import rfq, shapes  # noqa: E402
from powerdesk.curve import Quote, _daytype  # noqa: E402
from powerdesk.markets import get_market  # noqa: E402

BERLIN = ZoneInfo("Europe/Berlin")
TODAY = dt.date(2026, 10, 28)


def synthetic_doc(year: int) -> dict:
    """A year of hourly history: dear evenings, cheap middays that go negative on sunny spring
    and summer days, solar high exactly when middays are cheap, gusty days cheaper."""
    rnd = random.Random(1000 + year)
    start = int(dt.datetime(year, 1, 1, tzinfo=BERLIN).timestamp())
    stop = int(dt.datetime(year + 1, 1, 1, tzinfo=BERLIN).timestamp())
    price, solar, wind = [], [], []
    last_day, sun, gust = None, 1.0, 1.0
    for t in range(start, stop, 3600):
        loc = dt.datetime.fromtimestamp(t, BERLIN)
        if loc.date() != last_day:
            last_day = loc.date()
            sun, gust = rnd.uniform(0.2, 1.0), rnd.uniform(0.3, 1.7)
        h, m = loc.hour, loc.month
        season = 0.6 + 0.4 * math.cos(2 * math.pi * (m - 1) / 12)
        bell = max(0.0, math.sin(math.pi * (h - 6) / 12)) if 6 <= h <= 18 else 0.0
        summer = 0.5 + 0.5 * math.sin(math.pi * (m - 3) / 6) if 3 <= m <= 9 else 0.2
        p = 90 * season * (1.35 if 17 <= h < 21 else 1.0) - 70 * bell * sun * summer - 15 * (gust - 1)
        if _daytype(loc.date()) > 0:
            p -= 12
        price.append(round(p, 2))
        solar.append(round(10000 * bell * sun * summer, 0))
        wind.append(round(5000 * gust, 0))
    return {"zone": "DE", "year": year, "tz": "Europe/Berlin", "start": start, "hours": len(price),
            "fetched_utc": f"{year + 1}-01-02T00:00:00+00:00", "price": price, "solar": solar, "wind_onshore": wind}


def window(doc: dict, first: dt.date, end: dt.date) -> dict:
    """The part of a year from local midnight on `first` to `end` (what the fixture carries)."""
    a = int(dt.datetime.combine(first, dt.time(), BERLIN).timestamp())
    b = int(dt.datetime.combine(end, dt.time(), BERLIN).timestamp())
    i, j = (a - doc["start"]) // 3600, (b - doc["start"]) // 3600
    return {**doc, "start": a, "hours": j - i, **{k: doc[k][i:j] for k in ("price", "solar", "wind_onshore")}}


FULL = {y: synthetic_doc(y) for y in (2024, 2025)}
STATS = {"years": {}}
for y, d in FULL.items():
    st = shapes.year_stats(y, d["start"], d["price"], {k: d.get(k) or [] for k in ("solar", "wind_onshore", "wind_offshore")},
                           get_market("DE"))
    st["full"] = True
    STATS["years"][str(y)] = st
DOCS = {y: window(d, dt.date(y, 4, 1), dt.date(y, 7, 1)) for y, d in FULL.items()}
YEARS = [2024, 2025]
QUOTES = [Quote("Cal27", 85.0, 95.0), Quote("Q2-27", 70.0, None), Quote("Cal28", 80.0, None)]


def iso(x):
    if isinstance(x, dt.date):
        return x.isoformat()
    if isinstance(x, dict):
        return {k: iso(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [iso(v) for v in x]
    return x


cases = []
for name, mode, start, months, growth, kind, args in [
    ("ppa solar paid", "multiplicative", dt.date(2027, 4, 1), 3, 0.0, "ppa",
     dict(kind="solar", capacity=20, yield_mwh=1000, balancing=2.0, risk=1.0, margin=0.5)),
    ("ppa solar curtailed, additive", "additive", dt.date(2027, 4, 1), 3, 0.0, "ppa",
     dict(kind="solar", curtail=True, balancing=1.5, discount=0.05)),
    ("ppa wind, months without history", "multiplicative", dt.date(2027, 1, 1), 15, 0.02, "ppa",
     dict(kind="wind", yield_mwh=2200, degradation=0.005, trend=-0.01, discount=0.05, risk=1.5, margin=1.0)),
    ("toll 2h one cycle", "multiplicative", dt.date(2027, 4, 1), 3, 0.0, "toll",
     dict(hours=2, cycles=1, discount=0.05)),
    ("toll 1h two cycles, months without history", "multiplicative", dt.date(2027, 1, 1), 15, 0.02, "toll",
     dict(hours=1, cycles=2, availability=0.95, degradation=0.02, realism=0.6, other=5000.0, trend=-0.02, risk=0.12,
          margin=0.04, discount=0.05)),
    ("toll 4h, beyond the quotes", "additive", dt.date(2028, 7, 1), 24, 0.03, "toll", dict(hours=4, cycles=1)),
]:
    cv, assumed = rfq.tenor_curve(QUOTES, "DE", STATS, YEARS, mode, start, months, growth)
    if kind == "ppa":
        res = rfq.ppa(cv, DOCS, STATS, YEARS, start=start, months=months, today=TODAY, **args)
    else:
        res = rfq.toll(cv, DOCS, YEARS, start=start, months=months, today=TODAY, **args)
    cases.append({"name": name, "mode": mode, "start": start.isoformat(), "months": months, "growth": growth,
                  "kind": kind, "args": args, "assumed": [{"product": q.product, "base": q.base} for q in assumed],
                  "curve_months": len(cv.months), "result": iso(res)})

rnd = random.Random(11)
days = [[round(rnd.uniform(-60, 220), 2) for _ in range(24)] for _ in range(12)]
battery = [{"prices": p, "hours": k, "cycles": c, "out": list(rfq.battery_dp(p, k, 0.85, c))}
           for p in days for k, c in ((1, 1), (2, 1), (2, 2), (4, 1))]
hm = rfq.history_months(DOCS, "DE", "solar")[(2025, 5)]
months_check = {"key": "2025-5", "days": len(hm.days), "mean": hm.mean, "daytypes": [d.daytype for d in hm.days],
                "gen0": hm.days[0].gen[:24]}
json.dump({"today": TODAY.isoformat(), "years": YEARS, "quotes": [{"product": q.product, "base": q.base, "peak": q.peak} for q in QUOTES],
           "stats": STATS, "docs": {str(y): d for y, d in DOCS.items()}, "cases": cases, "battery": battery,
           "history": months_check}, sys.stdout, separators=(",", ":"))
print()
