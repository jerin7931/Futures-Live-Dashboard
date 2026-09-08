"""Run and persist the narrowly scoped PRE-COMMIT V4 verification suite."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


TARGETED = "provider_health_contract_aligns or provider_health_publisher_maps"


def run(command: list[str], cwd: Path) -> dict[str, object]:
    result = subprocess.run(command, cwd=cwd, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, check=False)
    return {"command": command, "exit_code": result.returncode, "output": result.stdout}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--live-root", type=Path, required=True)
    args = parser.parse_args(); repo=args.repo_root.resolve(); live=args.live_root.resolve()
    evidence=repo/"audit/production_precommit_v4"; evidence.mkdir(parents=True,exist_ok=True)
    checks = {
        "targeted_regressions": run([sys.executable,"-m","pytest","tests/test_predictive_live.py","-q",
            "--basetemp=audit/pytest_final_v4_targeted",
            "--junitxml=audit/production_precommit_v4/targeted_regression_tests.xml","-k",TARGETED],repo),
        "pytest": run([sys.executable,"-m","pytest","tests","-q",
            "--basetemp=audit/pytest_final_v4",
            "--junitxml=audit/production_precommit_v4/full_test_suite.xml"],repo),
        "python_compileall": run([sys.executable,"-m","compileall","-q",
                                   "backend/predictive_live","scripts"],repo),
        "javascript_syntax": run(["node","--check","predictive/predictive.js"],repo),
        "powershell_syntax": run(["pwsh","-NoProfile","-Command",
            "$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile('C:\\Users\\jerin\\Documents\\TradyticsPredictiveLive\\ops\\start_predictive_live.ps1',[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|ForEach-Object{$_.Message};exit 1};'PASS'"],repo),
        "startup_verify_only": run([sys.executable,"backend/tradytics_predictive_live_service.py",
                                     "--config",str(live/"config/predictive_live_v1.json"),"--verify-only"],repo),
    }
    for name, result in checks.items():
        (evidence/f"{name}.txt").write_text(str(result["output"]),encoding="utf-8")
    summary={"status":"PASS" if all(result["exit_code"]==0 for result in checks.values()) else "FAIL",
             "created_at":datetime.now(timezone.utc).isoformat(),
             "scope":"exact nine-value provider-health contract alignment across backend, frontend, publisher, and proposed Supabase migration",
             "checks":{name:{"command":result["command"],"exit_code":result["exit_code"]}
                       for name,result in checks.items()},
             "production_commit":False,"production_deploy":False,"migration_applied":False,
             "latency_rerun":False,"latency_note":"No decision-path or hot-path behavior changed in V4."}
    (evidence/"verification_summary.json").write_text(json.dumps(summary,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(summary,indent=2)); return 0 if summary["status"]=="PASS" else 2


if __name__=="__main__": raise SystemExit(main())
