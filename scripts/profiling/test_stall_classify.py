"""Mission 1 golden: synthetic frozen progress → stall; tip lag → TIP_FOLLOW."""

from stall_classify import classify_stall, synthetic_frozen_fixture


def test_tip_follow():
    assert (
        classify_stall(
            head=1000,
            fetched=980,
            processed=990,
            rates={"processed_bps": 1.0, "fetched_bps": 1.0, "events_per_sec": 0.0, "head_bps": 0.1},
            tip_lag_blocks=500,
        )
        == "TIP_FOLLOW"
    )


def test_synthetic_frozen_is_stall():
    f = synthetic_frozen_fixture()
    klass = classify_stall(**f)
    assert klass in {"FULL_STALL", "FETCH_STALL", "PROCESS_STALL"}
    assert klass != "TIP_FOLLOW"


def test_process_stall():
    assert (
        classify_stall(
            head=20_000_000,
            fetched=19_000_000,
            processed=18_000_000,
            rates={
                "processed_bps": 0.0,
                "fetched_bps": 50.0,
                "events_per_sec": 0.0,
                "head_bps": 0.1,
            },
        )
        == "PROCESS_STALL"
    )


def test_fetch_stall():
    assert (
        classify_stall(
            head=20_000_000,
            fetched=18_000_000,
            processed=18_000_000,
            rates={
                "processed_bps": 0.0,
                "fetched_bps": 0.0,
                "events_per_sec": 0.0,
                "head_bps": 0.2,
            },
        )
        == "FETCH_STALL"
    )


if __name__ == "__main__":
    test_tip_follow()
    test_synthetic_frozen_is_stall()
    test_process_stall()
    test_fetch_stall()
    print("ok")
