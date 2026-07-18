"""Mission 1 — stall classifier (pure; thresholds from baseline, not hard-coded quiet-minutes)."""

from __future__ import annotations

from typing import Any, Mapping, Optional


def classify_stall(
    *,
    head: int,
    fetched: int,
    processed: int,
    rates: Optional[Mapping[str, Any]] = None,
    tip_lag_blocks: int = 500,
) -> str:
    """Classify indexer progress for one chain sample.

    rates keys (optional, deltas vs previous sample):
      processed_bps, fetched_bps, events_per_sec, head_bps
    """
    lag = head - processed
    rates = rates or {}
    proc_bps = rates.get("processed_bps")
    fetch_bps = rates.get("fetched_bps")
    head_bps = rates.get("head_bps")
    events_per_sec = rates.get("events_per_sec")

    if lag <= tip_lag_blocks:
        return "TIP_FOLLOW"
    if proc_bps is None or fetch_bps is None:
        return "UNKNOWN"

    # Sparse history: blocks advance, events do not.
    if proc_bps > 0 and (events_per_sec or 0) == 0:
        return "SPARSE_NORMAL"

    # Head advances while fetch is flat → source/fetch stall.
    if (head_bps or 0) > 0 and fetch_bps <= 0 and proc_bps <= 0:
        return "FETCH_STALL"

    if fetch_bps > 0 and proc_bps <= 0:
        return "PROCESS_STALL"

    if fetch_bps <= 0 and proc_bps <= 0:
        if (head_bps or 0) > 0:
            return "FULL_STALL"
        return "FULL_STALL"

    return "CATCHUP"


def synthetic_frozen_fixture() -> dict[str, Any]:
    """Frozen-progress fixture that must classify as a stall (not TIP_FOLLOW)."""
    return {
        "head": 20_000_000,
        "fetched": 15_000_000,
        "processed": 15_000_000,
        "rates": {
            "processed_bps": 0.0,
            "fetched_bps": 0.0,
            "events_per_sec": 0.0,
            "head_bps": 0.1,
        },
    }
