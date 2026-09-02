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

- **Automated (pytest)**: `.srt` timestamp/format edge cases, ffmpeg `argv`
  construction (including Windows path escaping for the `subtitles=`
  filter), the job state machine (including the concurrent-job guard),
  and the API layer with Whisper/ffmpeg mocked out.
- **Deliberately manual**: actual transcription accuracy, actual burned-in
  caption visual/timing quality, and cross-platform ffmpeg quirks beyond
  what the `argv` tests already cover. Run
  `python scripts/smoke_test_pipeline.py <a real short video> --hardsub`
  and look at the result - a passing test suite alone doesn't mean the
  pipeline actually works, only that nothing regressed. If you touch
  anything under `pipeline.py`, `translate.py`, or `ffmpeg_utils.py`, run
  the smoke script against a real video before opening the PR.
