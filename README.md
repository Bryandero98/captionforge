# CaptionForge

**English** | [Español](README.es.md)

Local, free automatic video captions - the CapCut/Kapwing auto-caption
experience, but 100% on your own machine. No watermark, no monthly limit,
no account.

Drag in a video, get back a `.srt` file and/or the video with subtitles
burned in, in a modern social-media style. Transcription runs locally via
[faster-whisper](https://github.com/SYSTRAN/faster-whisper); translation
(to any language, not just English) runs locally via
[argos-translate](https://github.com/argosopentech/argos-translate);
burning subtitles into the video uses [ffmpeg](https://ffmpeg.org/).
Nothing leaves your machine.

## Requirements

- Python 3.10+
- [ffmpeg](https://ffmpeg.org/download.html) on your `PATH`

## Install & run

```sh
pip install -e ".[dev]"
captionforge serve
```

This starts a local server (default `http://127.0.0.1:8420/`) and opens it
in your browser. The **ES / EN** switch in the top-right corner sets the
UI language (remembered for next time via `localStorage`; it defaults to
your browser's own language). Drag in a video, choose a Whisper model size
and optionally a source language / translation target, and click
**Generate captions**. Once transcription finishes you can download the
`.srt` directly, or click **Burn into video** to burn the captions into
the video itself (a separate, on-demand step - you're never forced to
re-encode the whole video just to get the text).

CaptionForge processes one video at a time by design - a second upload
while one is running is rejected with a clear error rather than silently
queued.

## How it's built

- `src/captionforge/srt.py` - pure `.srt` timestamp formatting and
  assembly, no I/O.
- `src/captionforge/translate.py` - local translation of already-timed
  segments via argos-translate, decoupled from Whisper (whose own
  `task="translate"` only ever translates into English).
- `src/captionforge/ffmpeg_utils.py` - pure ffmpeg `argv` construction
  (audio extraction, subtitle burning with a bold-white/black-outline
  style) - never executes anything itself.
- `src/captionforge/jobs.py` - an in-memory, thread-safe job state
  machine (`queued -> extracting_audio -> transcribing -> done ->
  burning_subtitles -> burned`, or `error` from anywhere).
- `src/captionforge/pipeline.py` - orchestrates the above: ffmpeg runs via
  `asyncio.create_subprocess_exec`, Whisper/Argos (blocking, CPU-bound)
  run in a worker thread via `asyncio.to_thread`, so the server stays
  responsive (including the live progress stream) while a video is
  processing.
- `src/captionforge/app.py` + `routes/` - the FastAPI layer: upload,
  Server-Sent Events for live progress, and the `.srt`/video downloads.
- `src/captionforge/static/` - the frontend: one plain HTML/CSS/JS page,
  no build step, no framework. `i18n.js` is a small flat-dictionary
  translator (Spanish/English, `localStorage`-backed) that drives every
  `data-i18n`-tagged element in `index.html`; job stage labels are derived
  client-side from the language-neutral `status` field the API already
  returns, not from the backend's own (Spanish-only) `stage_label` text.

`scripts/smoke_test_pipeline.py` exercises the whole transcribe ->
translate -> burn pipeline directly against a real video, no server
involved - the fastest way to sanity-check the core after touching
anything Whisper/ffmpeg/Argos-related.

## Development

```sh
python -m venv .venv
source .venv/Scripts/activate   # or .venv/bin/activate on Linux/macOS
pip install -e ".[dev]"
pytest
```

`tests/fixtures/tiny_test_clip.mp4` is a real ~10s clip (synthesized
speech) used by the live-pipeline tests - not a mock.

## Known limitations

- `argos-translate`'s default `compute_type="auto"` resolves to a quantized
  kernel that silently produces garbage (repetition-loop) output for at
  least one language pair on at least one real CPU - verified live during
  development. `captionforge` forces `float32` (see `translate.py`) to
  avoid this; if you use `argos-translate` directly elsewhere, verify your
  own language pair isn't affected before trusting quantized output.
- The UI language switch is frontend-only. Everyday status text (stage
  labels, generic error framing) is fully bilingual, but the rare
  server-generated error message - an unsupported file format, a job
  conflict, an ffmpeg failure - is still written in Spanish by the backend
  and shown as-is regardless of the selected UI language.
