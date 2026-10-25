"""Make tests/options-fixture.json from PowerDesk's Python pricers (the reference).

    python tests/make_options_fixture.py ../PowerDesk > tests/options-fixture.json
"""
import itertools
import json
import sys

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "../PowerDesk")
from powerdesk import options as o  # noqa: E402

cases = []
add = lambda fn, args, out: cases.append({"fn": fn, "args": args, "out": out})
g = lambda x: {"price": x.price, "delta": x.delta, "gamma": x.gamma, "vega": x.vega, "theta": x.theta}

for F, K, T, s, r, kind in itertools.product([40, 85, 150], [50, 90, 140], [0.02, 0.25, 1.5], [0.15, 0.45, 1.2], [0, 0.03], ["call", "put"]):
    add("black76Greeks", [F, K, T, s, r, kind], g(o.black76_greeks(F, K, T, s, r, kind)))
for F, K, T, s, r, kind in itertools.product([-10, 40, 85], [-5, 50, 90], [0.1, 1.0], [5, 40], [0, 0.03], ["call", "put"]):
    add("bachelierGreeks", [F, K, T, s, r, kind], g(o.bachelier_greeks(F, K, T, s, r, kind)))
for F, K, T, s, kind in [(85, 90, 0.25, 0.4, "call"), (85, 60, 0.5, 0.7, "put"), (30, 45, 1.0, 0.25, "call")]:
    p = o.black76(F, K, T, s, 0, kind)
    add("black76Iv", [p, F, K, T, 0, kind], s)
    pn = o.bachelier(F, K, T, s * F, 0, kind)
    add("bachelierIv", [pn, F, K, T, 0, kind], s * F)
for F2, K, T, rho, kind in itertools.product([50, 66.5], [-5, 0, 27.9], [0.08, 0.5], [0, 0.8], ["call", "put"]):
    add("kirk", [95, F2, K, T, 0.45, 0.5, rho, 0.02, kind], o.kirk(95, F2, K, T, 0.45, 0.5, rho, 0.02, kind))
add("margrabe", [95, 70, 0.5, 0.45, 0.5, 0.8, 0.0], o.margrabe(95, 70, 0.5, 0.45, 0.5, 0.8, 0.0))

for n, s, K, kind in itertools.product([1, 10, 31], [0.3, 0.9], [80, 90, 110], ["call", "put"]):
    times = [0.1 + (d + 0.5) / 365 for d in range(n)]
    C = o.gbm_cov(times, s)
    fwd = [90 + 4 * ((d % 7) < 5) for d in range(n)]   # weekdays dearer than weekends
    add("asianGeometric", [fwd, C, K, times[-1], 0.01, kind], o.asian_geometric(fwd, C, K, times[-1], 0.01, kind))
    add("asianMm", [fwd, C, K, times[-1], 0.01, kind, None, 0], o.asian_mm(fwd, C, K, times[-1], 0.01, kind))
times = [(d + 0.5) / 365 for d in range(10)]
C = o.gbm_cov(times, 0.5)
for K in (40, 75, 95):
    for kind in ("call", "put"):
        args = [[85] * 10, C, K, times[-1], 0, kind, [1 / 30] * 10, 20 * 70 / 30]
        add("asianMm", args, o.asian_mm([85] * 10, C, K, times[-1], 0, kind, [1 / 30] * 10, 20 * 70 / 30))

models = [(1.2, 5, 0.35, 0.0), (0.8, 15, 0.25, 0.3), (2.0, 2, 0.5, -0.2)]
for ss, hl, sl, rho in models:
    m = o.TwoFactor.from_half_life(ss, hl, sl, rho)
    for ttd in (0, 2 / 365, 30 / 365, 1.0):
        add("forwardVol", [[ss, hl, sl, rho], ttd], m.forward_vol(ttd))
    for args in [(0.1, 0.12, 0.08, 0.2), (0.5, 0.5, 0.5, 0.55), (0.02, 0.03, 0.02, 0.03)]:
        add("logCov", [[ss, hl, sl, rho], *args], m.log_cov(*args))
    for start_days, days, K, kind in [(30, 31, 100, "call"), (60, 28, 85, "put"), (10, 30, 90, "call")]:
        start = start_days / 365
        r = o.month_options(m, 90.0, K, start, days, start - 2 / 365, 0, kind)
        add("monthOptions", [[ss, hl, sl, rho], 90.0, K, start, days, start - 2 / 365, 0, kind],
            {"european": r.european, "asian": r.asian, "vFuture": r.v_future, "vAverage": r.v_average,
             "futureVol": r.future_vol, "mean": r.mean})

json.dump(cases, sys.stdout, separators=(",", ":"))
print()
