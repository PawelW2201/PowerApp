"""Make tests/intraday-fixture.json from PowerDesk's Python intraday simulator (the reference),
on a made-up day: no market data goes into this public repository.

    python tests/make_intraday_fixture.py ../PowerDesk > tests/intraday-fixture.json
"""
import json
import sys

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "../PowerDesk")
from powerdesk import intraday as I  # noqa: E402

DAY = [92.0, 86.0, 82.0, 81.0, 84.0, 93.0, 110.0, 112.0, 95.0, 70.0, 48.0, 38.0,
       33.0, 30.0, 33.0, 45.0, 62.0, 88.0, 112.0, 140.0, 180.0, 150.0, 118.0, 104.0]

CASES = [
    ("drift only, free trading", dict(sigma=8.0, phi=0.8, per_day=0.0, cost=0.0), dict(hours=2, round_trip=0.85, cycles=2), 30, 7),
    ("spikes and trading costs", dict(sigma=6.0, phi=0.6, per_day=2.0, size=90.0, length=2.0, shape=0.8, cost=2.0),
     dict(hours=2, round_trip=0.85, cycles=2), 30, 11),
    ("one hour, one cycle, long spikes", dict(sigma=10.0, phi=0.9, per_day=1.5, size=120.0, length=3.0, shape=0.5, cost=1.0),
     dict(hours=1, round_trip=0.9, cycles=1), 30, 3),
    ("four hours on a coarse grid", dict(sigma=5.0, phi=0.5, per_day=3.0, size=60.0, length=1.5, shape=0.9, cost=3.0, levels=9, bins=2),
     dict(hours=4, round_trip=0.85, cycles=2), 20, 5),
]


def js_world(kw):
    return {("perDay" if k == "per_day" else k): v for k, v in kw.items()}


cases = []
for name, wkw, bkw, days, seed in CASES:
    w = I.world(DAY, **wkw)
    b = I.Battery(**bkw)
    r = I.simulate(w, b, days=days, seed=seed)
    ns = len(w.jump)
    quotes = [[h, t, x, w.quote(h, t, x)] for h, t, x in ((5, 2, 0), (20, 13, w.nx - 1), (9, 8, w.nx // 2 + 1))]
    ex = r["example"]
    cases.append({
        "name": name, "world": js_world(wkw), "battery": {"hours": bkw["hours"], "roundTrip": bkw["round_trip"], "cycles": bkw["cycles"]},
        "days": days, "seed": seed,
        "drift": w.drift, "jump": w.jump, "comp": w.comp, "mean_id": w.mean_id, "quotes": quotes,
        "pd_row": w.pd[len(w.drift) // 2], "ps_row": w.ps[20][0],
        "policies": r["policies"], "day_ahead_actions": r["day_ahead_actions"],
        "example": {"intraday": ex["intraday"], "spike": ex["spike"], "actions": ex["actions"], "values": ex["values"]} if ex else None,
    })

name, wkw, bkw, _, _ = CASES[1]
sweep = {"world": js_world(wkw), "battery": {"hours": 2, "roundTrip": 0.85, "cycles": 2}, "perDays": [0.0, 2.0], "days": 15, "seed": 9,
         "result": I.sweep(DAY, I.Battery(**bkw), per_day=(0.0, 2.0), days=15, seed=9, **{k: v for k, v in wkw.items() if k != "per_day"})}
gen = I.rng(20261028)
json.dump({"day": DAY, "rng": {"seed": 20261028, "values": [gen() for _ in range(6)]}, "cases": cases, "sweep": sweep},
          sys.stdout, separators=(",", ":"))
print()
