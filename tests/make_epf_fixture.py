"""Make tests/epf-fixture.json from PowerDesk's live day-ahead forecast (powerdesk/epf.py, the
reference), on made-up days: no market data goes into this public repository.

    python tests/make_epf_fixture.py ../PowerDesk > tests/epf-fixture.json

Four delivery days of the live cycle through the files, as epf-live.yml runs it: the morning
forecasts before the noon auction (one without Hungary's solar forecast, which comes late), the
afternoon score and the next day's placeholder, a day whose German forecasts come too late (the average
on Hungary's inputs is scored), and a day whose Hungarian load forecast never comes (the naive
is). The summaries written along the way are what the app reads.
"""
import datetime as dt
import json
import math
import os
import random
import sys
import tempfile
from zoneinfo import ZoneInfo

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "../PowerDesk")
from powerdesk import epf  # noqa: E402

BUD = ZoneInfo("Europe/Budapest")
START, T1 = dt.date(2025, 11, 1), dt.date(2026, 2, 22)     # T1 a Sunday: Sun to Wed forecast and scored
T2, T3, T4 = (T1 + dt.timedelta(days=k) for k in (1, 2, 3))
DAY = dt.timedelta(days=1)


def synthetic(seed=5):
    """Prices that follow residual load (Hungary's and Germany's) plus noise, to the cent."""
    rnd = random.Random(seed)
    hu, de = {}, {}
    d = START
    while d <= T4:
        sun, gust, gust_de, sun_de = rnd.uniform(0.2, 1), rnd.uniform(0, 1), rnd.uniform(0, 1), rnd.uniform(0.2, 1)
        bell = [max(0.0, math.sin(math.pi * (q / 4 - 6) / 12)) if 24 <= q < 72 else 0.0 for q in range(96)]
        load = [4500 + 900 * math.sin(math.pi * q / 96) + (0 if d.weekday() < 5 else -500) for q in range(96)]
        solar = [3000 * b * sun for b in bell]
        wind = [800 * gust] * 96
        load_de = [55000 + 9000 * math.sin(math.pi * q / 96) for q in range(96)]
        solar_de = [40000 * b * sun_de for b in bell]
        wind_de = [30000 * gust_de] * 96
        price = [round(40 + 0.012 * (l - s - w) + 0.002 * (a - b - c) + rnd.gauss(0, 4), 2)
                 for l, s, w, a, b, c in zip(load, solar, wind, load_de, solar_de, wind_de)]
        hu[d] = {"price": price, "load": load, "solar": solar, "wind": wind}
        de[d] = {"price": [None] * 96, "load": load_de, "solar": solar_de, "wind": wind_de}
        d += DAY
    return hu, de


def write_store(root, hu, de, priced, inputs, holes=()):
    """The store as ENTSO-E shows it at some moment: prices through `priced`, forecasts through
    `inputs`, and (zone, day, series) `holes` not published."""
    none = [None] * 96
    for zone, days in (("HU", hu), ("DE", de)):
        tz = ZoneInfo(epf.TZ[zone])
        months = {}
        for d, r in days.items():
            st = epf.day_starts(d, tz)
            p = r["price"] if d <= priced and zone == "HU" else none
            got = lambda k: none if d > inputs or (zone, d, k) in holes else r[k]
            months.setdefault(d.strftime("%Y-%m"), {})[d.isoformat()] = {
                "t0": st[0], "n": len(st), "price_step": 900 if p is not none else None, "price": p, "load": got("load"),
                "solar": got("solar"), "wind_onshore": got("wind"), "wind_offshore": none}
        os.makedirs(os.path.join(root, zone), exist_ok=True)
        for m, recs in months.items():
            with open(os.path.join(root, zone, f"{m}.json"), "w") as f:
                json.dump({"zone": zone, "month": m, "tz": epf.TZ[zone], "fetched_utc": "2026-02-01T00:00:00+00:00",
                           "days": recs, "errors": []}, f)


def at(day, h, m):
    return dt.datetime.combine(day, dt.time(h, m), BUD)


def main():
    hu, de = synthetic()
    runs = []
    with tempfile.TemporaryDirectory() as root:
        # the backtest the summary quotes for scale: ten days before the live ones
        write_store(root, hu, de, T4, T4)
        hu96, de96 = epf.days96(epf.load_store(root, "HU"), BUD), epf.days96(epf.load_store(root, "DE"), ZoneInfo("Europe/Berlin"))
        bt = epf.backtest(hu96, de96, start=T1 - 10 * DAY, end=T1 - DAY)
        os.makedirs(os.path.join(root, "results"))
        with open(os.path.join(root, "results", "HU-fixture.json"), "w") as f:
            json.dump(bt, f)

        def run(when, keep, priced, inputs, holes=()):
            write_store(root, hu, de, priced, inputs, holes)
            s = epf.live(root, when, fetch_data=False, log=lambda *_: None)
            if keep:
                runs.append({"name": keep, "now_utc": when.astimezone(dt.timezone.utc).isoformat(timespec="seconds"), "summary": s})

        no_sun = {("HU", T2, "solar")}
        de_late = {("DE", T3, k) for k in ("load", "solar", "wind")}
        no_hu_load = {("HU", T4, "load")}
        run(at(T1 - DAY, 10, 17), "first forecast", T1 - DAY, T1)
        run(at(T1 - DAY, 13, 47), None, T1, T1)                                   # T1 scored, T2's placeholder
        run(at(T2 - DAY, 10, 17), "no solar yet", T1, T2, no_sun)                  # LEAR without wind and solar
        run(at(T2 - DAY, 11, 41), None, T1, T2)                                   # the solar forecast is out: LEAR
        run(at(T2 - DAY, 13, 47), "scored", T2, T2)                               # T2 scored on LEAR, T3's placeholder
        run(at(T3 - DAY, 10, 17), "germany late", T2, T3, de_late)                # LEAR + XGBoost on Hungary's inputs
        run(at(T3 - DAY, 13, 47), None, T3, T3, de_late)                          # T3 scored on it, T4's placeholder
        run(at(T4 - DAY, 10, 17), None, T3, T4, no_hu_load)                       # no Hungarian load: the naive counts
        run(at(T4 - DAY, 13, 47), "final", T4, T4, no_hu_load)                    # T4 scored, the day after's placeholder
    prices = {d.isoformat(): hu[d]["price"] for d in sorted(hu) if d >= T1 - 7 * DAY}
    print(json.dumps({"note": "made-up days through PowerDesk's live forecast; not market data",
                      "prices": prices, "runs": runs}, separators=(",", ":")))


if __name__ == "__main__":
    main()
