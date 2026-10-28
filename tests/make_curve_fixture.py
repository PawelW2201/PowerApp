"""Make tests/curve-fixture.json from PowerDesk's Python curve engine (the reference),
on synthetic statistics only: no market data goes into this public repository.

    python tests/make_curve_fixture.py ../PowerDesk > tests/curve-fixture.json
"""
import json
import math
import sys

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "../PowerDesk")
from powerdesk import curve as c  # noqa: E402
from powerdesk.products import parse  # noqa: E402


def stats():
    rho = [1.3, 1.2, 1.05, 0.9, 0.8, 0.8, 0.85, 0.85, 0.95, 1.05, 1.2, 1.3]
    base = [100 * r for r in rho]
    shape = [[[(0.6 + 0.02 * m if 10 <= h < 15 else 1.35 if 17 <= h < 21 else 1.0) * (1.0 if d == 0 else 0.85 - 0.05 * d)
               for h in range(24)] for d in range(3)] for m in range(12)]
    solar = [[max(0.0, math.sin(math.pi * (h - 6) / 12)) * (500 + 60 * min(m, 11 - m)) if 6 <= h <= 18 else 0.0
              for h in range(24)] for m in range(12)]
    wind = [[900.0 + 300 * math.cos(math.pi * m / 6) + 50 * math.sin(h) for h in range(24)] for m in range(12)]
    y1 = {"full": True, "monthly": {"base": base, "peak": [b * (0.9 if 3 <= i <= 7 else 1.12) for i, b in enumerate(base)],
                                     "offpeak": [b * 0.97 for b in base]}, "shape": shape, "solar": solar, "wind": wind}
    y2 = json.loads(json.dumps(y1))
    y2["monthly"]["base"] = [b * 1.1 for b in base]
    y2["shape"][4][0][12] = None
    y3 = json.loads(json.dumps(y1))
    y3["full"] = False
    y3["monthly"]["base"] = base[:10] + [None, None]
    return {"years": {"2024": y1, "2025": y2, "2026": y3}}


S = stats()
CASES = [
    ([("Cal27", 85.0, None), ("Q1-27", 98.0, None)], "DE", [2024, 2025], "multiplicative"),
    ([("Cal27", 85.0, 95.0), ("Q1-27", 98.0, 110.0), ("Nov26", 105.0, 118.0), ("Dec26", 102.0, None)], "DE", [2024, 2025, 2026], "multiplicative"),
    ([("Q1-27", 100.0, None), ("Q2-27", 80.0, None), ("Q3-27", 80.0, None), ("Q4-27", 90.0, None), ("Cal27", 85.0, None)], "DE", [2025], "additive"),
    ([("Sum27", 70.0, 60.0), ("Win27", 95.0, None), ("Cal28", 82.0, 90.0)], "PL", [2024, 2025], "multiplicative"),
    ([("Cal27", 85.0, None)], "FR", [], "multiplicative"),
]
out = []
for quotes, market, years, mode in CASES:
    cv = c.build([c.Quote(p, b, k) for p, b, k in quotes], market, S if years else None, years, mode)
    probe = [p for p in ("Q1-27", "Q2-27", "Q3-27", "Jan27", "Mar27", "Oct27", "Cal27", "Nov26", "Sum27", "Cal28") if cv.covers(parse(p))]
    solar = c.gen_profile(S, years, "solar") if years else None
    wind = c.gen_profile(S, years, "wind") if years else None
    out.append({
        "quotes": [{"product": p, "base": b, "peak": k} for p, b, k in quotes], "market": market, "years": years, "mode": mode,
        "months": [{"label": m["label"], "base": m["base"], "peak": m["peak"], "offpeak": m["offpeak"],
                    "quoted": m["quoted"], "constrained": m["constrained"]} for m in cv.months],
        "checks": [{k: ch[k] for k in ("label", "profile", "quote", "implied")} for ch in cv.checks],
        "level": cv.level, "n": len(cv.t), "t0": cv.t[0], "sum": sum(cv.price),
        "sample": [[i, cv.t[i], cv.hour[i], cv.peak[i], cv.price[i]] for i in range(0, len(cv.t), 97)],
        "products": {p: cv.product(parse(p)) for p in probe},
        "blocks": {p: cv.block(parse(p), {0, 1, 2, 3, 4}, 17, 21) for p in probe},
        "capture": {p: {"solar": cv.capture(parse(p), solar) if solar else None, "wind": cv.capture(parse(p), wind) if wind else None}
                    for p in probe},
        "battery": {p: cv.battery(parse(p), 2, 0.85) for p in probe[:3]},
        "prior": c.seasonal_prior(S if years else None, years),
    })
json.dump({"stats": S, "cases": out}, sys.stdout, separators=(",", ":"))
print()
