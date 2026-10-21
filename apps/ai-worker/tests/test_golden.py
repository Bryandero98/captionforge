"""Vectores compartidos con el API (TypeScript): si cambia legacy/src/captionforge/srt.py hay que
regenerarlos (packages/contracts/scripts/gen-segments-golden.py), y así el API se entera de que debe seguirlo."""

from __future__ import annotations

import json

import pytest
from captionforge.srt import redistribute_word_timings, segments_from_dicts, segments_to_srt, word_timing_to_dict

from conftest import REPO

GOLDEN = json.loads((REPO / "packages" / "contracts" / "examples" / "segments-golden.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", GOLDEN["srt"], ids=lambda c: c["name"])
def test_srt_matches_the_shared_vectors(case: dict) -> None:
    assert segments_to_srt(segments_from_dicts(case["segments"])) == case["expected"]


@pytest.mark.parametrize("case", GOLDEN["redistribute"], ids=lambda c: repr(c["text"]))
def test_word_redistribution_matches_the_shared_vectors(case: dict) -> None:
    words = redistribute_word_timings(case["text"], case["start"], case["end"])
    assert (None if words is None else [word_timing_to_dict(w) for w in words]) == case["expected"]
