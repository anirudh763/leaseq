import json
import subprocess
import sys

import pytest

from tools import sabotage


def test_invalid_later_patch_does_not_modify_an_earlier_file(tmp_path, monkeypatch):
    monkeypatch.setattr(sabotage, "ROOT", tmp_path)
    first = tmp_path / "first.txt"
    second = tmp_path / "second.txt"
    first.write_text("original first")
    second.write_text("original second")
    with pytest.raises(SystemExit, match="not found exactly once"):
        sabotage.apply([("first.txt", "original", "broken"),
                        ("second.txt", "absent", "broken")])
    assert first.read_text() == "original first"
    assert second.read_text() == "original second"


def test_preflight_validates_sequential_patches_without_writing(tmp_path, monkeypatch):
    monkeypatch.setattr(sabotage, "ROOT", tmp_path)
    source = tmp_path / "source.txt"
    source.write_text("first third")
    patches = [("source.txt", "first", "second"), ("source.txt", "second", "fourth")]
    sabotage.planned_changes(patches)
    assert source.read_text() == "first third"
    originals = sabotage.apply(patches)
    try:
        assert source.read_text() == "fourth third"
    finally:
        for path, text in originals.items():
            path.write_text(text)
    assert source.read_text() == "first third"


@pytest.mark.parametrize("summary,expected", [
    ("1 failed in 0.01s", "CAUGHT"),
    ("1 failed, 1 error in 0.01s", "ERROR"),
    ("1 failed, 1 skipped in 0.01s", "SKIPPED"),
])
def test_runner_errors_and_skips_cannot_pass_as_caught(tmp_path, monkeypatch, summary, expected):
    monkeypatch.setattr(sabotage, "ROOT", tmp_path)
    source = tmp_path / "source.txt"
    source.write_text("original")
    monkeypatch.setattr(sabotage, "SABOTAGE", [("fixture", [("source.txt", "original", "mutant")], ["fixture-test"])])
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess([], 1, summary, ""))
    report = tmp_path / "report.json"
    monkeypatch.setattr(sys, "argv", ["sabotage.py", "--report", str(report)])
    result = sabotage.main()
    assert result == (0 if expected == "CAUGHT" else 1)
    assert json.loads(report.read_text())[0]["verdict"] == expected
    assert source.read_text() == "original"
