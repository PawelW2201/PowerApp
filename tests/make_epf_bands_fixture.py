"""Make tests/epf-bands-fixture.json from PowerDesk (powerdesk/bands.py and powerdesk/epf.py, the
reference), on made-up days: no market data goes into this public repository.

    python tests/make_epf_bands_fixture.py ../PowerDesk > tests/epf-bands-fixture.json

Two things the app reads beside the live cycle's summaries (make_epf_fixture.py):
    days      made-up quantiles around a forecast and the prices that came, each scored by
              powerdesk.bands.scores (the ranges' coverage and width)
    summary   epf.summary over live records with ranges, the way Hungary's are written since
              release 6 (latest.quantiles, last_scored.band_scores, days[].band), and Romania's,
              whose model is the gbm alone (release 7), with ranges as another zone's are written once
              it has them (release 7.5: the same fields)
"""
import datetime as dt
import json
import math
import random
import sys

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "../PowerDesk")
from powerdesk import bands, epf  # noqa: E402

Z = {"05": -1.645, "10": -1.2816, "25": -0.6745, "75": 0.6745, "90": 1.2816, "95": 1.645}


def made_up(rnd, k):
    """A day's forecast, its quantiles and its prices: errors of a scale that changes day to day."""
    f = [round(150 + 60 * math.sin((i - 20) / 15) + 10 * k, 2) for i in range(96)]
    sd = rnd.uniform(8, 30)
    q = {f"q{lv}": [round(x + z * sd * rnd.uniform(0.7, 1.3), 2) for x in f] for lv, z in Z.items()}
    for i in range(96):                        # keep the quantiles in order, as powerdesk.bands' are
        vals = sorted(q[f"q{lv}"][i] for lv in Z)
        for lv, v in zip(Z, vals):
            q[f"q{lv}"][i] = v
    y = [round(x + rnd.gauss(0, sd * 1.1), 2) for x in f]
    y[40] = q["q10"][40]                       # a price exactly on a band's end counts as inside
    return f, q, y


def main():
    rnd = random.Random(11)
    days = []
    for k in range(6):
        f, q, y = made_up(rnd, k)
        days.append({"forecast": f, "quantiles": q, "actual": y, "scores": bands.scores(q, y)})
    T0 = dt.date(2026, 11, 2)
    records = []
    for k, d in enumerate(days[:4]):
        T = (T0 + dt.timedelta(days=k)).isoformat()
        made = dt.datetime.combine(T0 + dt.timedelta(days=k - 1), dt.time(9, 5), dt.timezone.utc).isoformat()
        gate = dt.datetime.combine(T0 + dt.timedelta(days=k - 1), dt.time(11, 0), dt.timezone.utc).isoformat()
        naive = [round(v + 25, 2) for v in d["forecast"]]
        v = {"target": T, "made_utc": made, "gate_utc": gate, "main": "pool_c", "inputs": {"load": True, "solar": True, "wind": True,
             "load_de": True, "solar_de": False, "wind_de": False}, "forecasts": {"pool_c": d["forecast"], "naive": naive},
             "quantiles": d["quantiles"], "bands_seconds": 0.3}
        doc = {"target": T, "versions": [v]}
        if k < 3:                                  # the last one isn't priced yet
            doc["actual"] = d["actual"]
            doc["scores"] = {m: {"mae": sum(abs(a - b) for a, b in zip(fc, d["actual"])) / 96} for m, fc in v["forecasts"].items()}
            bands.score_doc(doc)
        records.append(doc)
    now = dt.datetime(2026, 11, 4, 15, 0, tzinfo=dt.timezone.utc)
    hu = epf.summary(records, None, now)
    ro_doc = {"target": "2026-11-02", "versions": [{"target": "2026-11-02", "made_utc": "2026-11-01T09:05:00+00:00",
              "gate_utc": "2026-11-01T11:00:00+00:00", "main": "gbm", "inputs": {"load": True, "solar": False, "wind": False},
              "forecasts": {"gbm": days[4]["forecast"], "naive": days[5]["forecast"]},
              "quantiles": days[4]["quantiles"]}],
              "actual": days[4]["actual"]}
    ro_doc["scores"] = {m: {"mae": sum(abs(a - b) for a, b in zip(fc, ro_doc["actual"])) / 96}
                        for m, fc in ro_doc["versions"][0]["forecasts"].items()}
    bands.score_doc(ro_doc)
    ro = epf.summary([ro_doc], None, now, "RO")
    print(json.dumps({"note": "made-up days through PowerDesk's ranges and summaries; not market data",
                      "days": days, "summary": {"HU": hu, "RO": ro}}, separators=(",", ":")))


if __name__ == "__main__":
    main()
