"""Production-policy recompute: refactored vs original production full-photo.

Re-measures the three saved production full predictions with the hardened
comparator (no inference rerun): refactored-assembly vs original-CUDA
production reference, frozen gates and exact expected identities. Production TF32 policy failures are preserved as failures;
this driver never loosens gates or promotes defaults.

Usage: compare_production_full.py [--fixtures DIR] [--report PATH]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from rapidraw_denoise.compare_full import compare_files  # noqa: E402

PHOTOS = ("portrait", "landscape", "phone")
EXPECTED = [f"{p}-newprod" for p in PHOTOS]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fixtures", default="/tmp/nlx-fixtures")
    ap.add_argument("--report", default="/tmp/nlx-production-full-report.json")
    args = ap.parse_args(argv)
    report_path = Path(args.report)
    if report_path.exists():
        print(json.dumps({"status": "error",
                          "error": f"refusing to overwrite {report_path}"}),
              file=sys.stderr)
        return 1
    try:
        out = []
        for photo in PHOTOS:
            name = f"{photo}-newprod"
            act = Path(args.fixtures) / f"{photo}-newprod-full.npy"
            ref = (Path(args.fixtures) / f"{photo}-production-cuda"
                   / "full-prediction.npy")
            for p, what in ((act, "refactored assembly"), (ref, "production reference")):
                if not p.is_file() or p.stat().st_size == 0:
                    raise FileNotFoundError(f"{name}: {what} missing: {p}")
            out.append(compare_files(name, act, ref))
        names = [e["comparison"] for e in out]
        if sorted(names) != sorted(EXPECTED):
            raise ValueError(f"case identities != expected three: {names}")
        report = {"status": "pass" if all(e["pass"] for e in out) else "fail",
                  "expected_cases": EXPECTED,
                  "note": "production-policy comparison (CUDA TF32 production "
                          "reference); failures preserved, not waived",
                  "comparisons": out}
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        for e in out:
            print(f"{e['comparison']}: {'PASS' if e['pass'] else 'FAIL'} "
                  f"max={e['max_abs_err']:.3g} mae={e['mae']:.3g} "
                  f"p99={e['p99_abs_err']:.3g} viol={e['elementwise_violations']} "
                  + " ".join(f"{k}max={v['max']:.2g}"
                             for k, v in e["regions"].items()))
        return 0 if all(e["pass"] for e in out) else 2
    except Exception as exc:
        error = {"status": "error", "error": f"{type(exc).__name__}: {exc}"}
        if not report_path.exists():
            report_path.write_text(json.dumps(error, indent=2) + "\n")
        print(json.dumps(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
