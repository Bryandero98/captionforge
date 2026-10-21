# Contributing

## Setup

```sh
python -m venv .venv
source .venv/Scripts/activate   # or .venv/bin/activate on Linux/macOS
pip install -e ".[dev]"
```

## Before opening a PR

```sh
ruff check .
ruff format --check .
mypy src
pytest
```

## What's actually tested, and what isn't

- **Automated (pytest)**: `.srt`/`.vtt`/`.ass` timestamp/format edge cases
  (including karaoke `\k` tags and ASS override-block escaping), ffmpeg
  `argv` construction (including Windows path escaping for the
  `subtitles=` filter), the job state machine (including the
  concurrent-job guard), the API layer with Whisper mocked out, and -
  `tests/test_pipeline.py` - `pipeline.py` itself against a REAL ffmpeg
  (audio extraction, plain and karaoke burns) and a real fixture video,
  with only Whisper stubbed. That last file exists because a real bug (a
  dropped import causing a `NameError`) once reached a live browser check
  without pytest ever running the actual code path - don't mock
  `run_transcription_job`/`run_burn_job` themselves without also keeping
  at least one test that executes them for real.
- **Deliberately manual**: actual transcription accuracy, actual burned-in
  caption visual/timing quality, and cross-platform ffmpeg quirks beyond
  what the `argv` tests already cover. Run
  `python scripts/smoke_test_pipeline.py <a real short video> --hardsub`
  and look at the result - a passing test suite alone doesn't mean the
  pipeline actually works, only that nothing regressed. If you touch
  anything under `pipeline.py`, `translate.py`, or `ffmpeg_utils.py`, run
  the smoke script against a real video before opening the PR.
