import subprocess
import sys

import pytest

from tools import sabotage


def test_inner_test_timeout_is_not_a_mutation_catch(tmp_path, monkeypatch):
    monkeypatch.setattr(sabotage, "ROOT", tmp_path)
    source = tmp_path / "source.txt"
    source.write_text("original")
    monkeypatch.setattr(sabotage, "SABOTAGE", [("fixture", [("source.txt", "original", "mutant")], ["fixture-test"])])
    output = "Traceback (most recent call last):\n subprocess.TimeoutExpired: node timed out\n1 failed in 180.00s\n"
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess([], 1, output, ""))
    report = tmp_path / "report.json"
    monkeypatch.setattr(sys, "argv", ["sabotage.py", "--report", str(report)])

    assert sabotage.main() == 1
    assert '"verdict": "ERROR"' in report.read_text()
    assert source.read_text() == "original"


@pytest.mark.parametrize("returncode,output,expected", [
    (1, "AssertionError: expected response 400\n1 failed in 0.01s", "CAUGHT"),
    (1, "DataError: invalid contract value\n1 failed in 0.01s", "CAUGHT"),
    (1, "ModuleNotFoundError: No module named 'pytest'\n1 failed in 0.01s", "ERROR"),
    (1, "SyntaxError: invalid syntax\n1 failed in 0.01s", "ERROR"),
    (1, "1 skipped in 0.01s", "SKIPPED"),
    (2, "2 errors in 0.01s", "ERROR"),
    (0, "2 passed in 0.01s", "MISSED"),
])
def test_result_classification(returncode, output, expected):
    assert sabotage.classify_result(returncode, output.splitlines()[-1], output) == expected


UP_STALLED_API_TIMEOUT = """FAILED tests/test_usability.py::test_up_gives_up_on_a_stalled_api_within_the_timeout
subprocess.TimeoutExpired: Command '['bash', '/tmp/project/scripts/up.sh']' timed out after 60 seconds
"""


@pytest.mark.parametrize("control_name,output,expected", [
    ("up.sh health check without a per-request timeout", UP_STALLED_API_TIMEOUT, "CAUGHT"),
    ("other control", UP_STALLED_API_TIMEOUT, "ERROR"),
    ("up.sh health check without a per-request timeout",
     "FAILED tests/test_usability.py::test_up_gives_up_on_a_stalled_api_within_the_timeout\n"
     "subprocess.TimeoutExpired: Command '['node', '/tmp/review_fixes.e2e.js']' timed out after 180 seconds",
     "ERROR"),
])
def test_only_the_up_healthcheck_control_may_catch_its_script_timeout(control_name, output, expected):
    assert sabotage.classify_result(1, "1 failed in 60.00s", output, control_name) == expected
