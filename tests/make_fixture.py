"""Make tests/products-fixture.json from PowerDesk's Python calendar (the reference).

    python tests/make_fixture.py ../PowerDesk > tests/products-fixture.json
"""
import datetime as dt
import json
import sys

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "../PowerDesk")
from powerdesk.products import delivery  # noqa: E402

CODES = ["Cal26", "Cal27", "Cal28", "Cal31", "Q1-27", "Q2-27", "Q3-27", "Q4-26", "Q4-27",
         "Sum27", "Win26", "Win27", "Jan27", "Feb28", "Mar27", "Oct26", "Oct27", "Nov26", "Dec26", "2027-05",
         "Wk01-27", "Wk44-26", "Wk53-26", "Wk13-27", "2026-10-25", "2027-03-28", "2027-12-24", "2026-11-11",
         "WE", "BOW", "BOM", "DA", "Wk45", "Wk43", "Wk01"]
ASOF = ["2026-10-25", "2026-10-28", "2026-10-31", "2026-12-29", "2027-03-27", "2027-06-15"]
MARKETS = ["DE", "PL", "HU", "CH", "ES"]

out = []
for asof in ASOF:
    for market in MARKETS:
        for code in CODES:
            try:
                d = delivery(code, market, dt.date.fromisoformat(asof))
            except ValueError as e:
                out.append({"code": code, "market": market, "asof": asof, "error": str(e)})
                continue
            out.append({
                "code": code, "market": market, "asof": asof,
                "label": d.period.label, "kind": d.period.kind,
                "first_day": d.period.start.isoformat(), "last_day": d.period.last_day.isoformat(),
                "start_utc_ms": int(d.start_utc.timestamp() * 1000),
                "end_utc_ms": int(d.end_utc.timestamp() * 1000),
                "hours": {"base": d.hours_base, "peak": d.hours_peak, "offpeak": d.hours_offpeak},
            })
json.dump(out, sys.stdout, separators=(",", ":"))
print()
