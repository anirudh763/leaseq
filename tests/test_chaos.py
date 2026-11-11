"""Reduced-size fault injection (the full-size run is scripts/chaos.py)."""
import chaos


def test_killing_workers_loses_nothing_and_duplicates_nothing():
    report = chaos.run_chaos(jobs=300, kills=12, workers=4, seed=7, lease_seconds=1.0)
    print(report)
    assert report["violations"] == []
    assert report["kills_delivered"] == 12
    assert report["done"] == 300
    assert report["effect_rows"] == 300 and report["jobs_with_effect"] == 300
    assert report["jobs_completed_more_than_once"] == 0
    # The run must actually have exercised recovery, or it proves nothing.
    assert report["jobs_needing_more_than_one_attempt"] > 0
    assert report["expired_leases_taken_over"] > 0


def test_negative_control_without_fencing_the_check_catches_duplicates():
    """Same harness, workers started with --unfenced, no kills at all: a quarter
    of the jobs stall past their lease on the first attempt. If the invariant
    checks could not see a double completion, this test would fail."""
    report = chaos.run_chaos(jobs=40, kills=0, workers=4, seed=7, lease_seconds=1.0,
                             stall_fraction=0.25, unfenced=True)
    print(report)
    assert report["effect_rows"] > 40
    assert report["jobs_completed_more_than_once"] > 0
    assert "exactly one effect row per job" in report["violations"]
