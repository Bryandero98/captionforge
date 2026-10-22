# Web client user guide

[Versión en español](guia-de-uso.md)

The web interface is served by the API itself (same origin): open `http://localhost:3000/` with the service running
(`npm run infra:up` and the API Gateway). This same guide is shown inside the page, under "How to use CaptionForge, step by step".

## Language

The interface uses your browser's language when it knows it: **Spanish, English, Portuguese, French, German or Italian**.
Switch with the ES · EN · PT · FR · DE · IT buttons in the corner; the choice is remembered in this browser.

Spanish and English are reviewed. **Portuguese, French, German and Italian are machine translations** waiting for review
by native speakers; the page says so when they are in use. To fix a text, edit its table in
`apps/web/public/js/i18n/messages.<lang>.js` and open a PR (a test checks that no key is missing and no `{x}`
placeholder changes).

## Step by step

1. **Choose your videos.** Drag up to 20 onto the dotted area or press "Choose a file". Formats: MP4, MOV, MKV, WEBM
   and AVI. Files that cannot be used are skipped and the reason is shown.
2. **Set the options.** *Model*: Base is the fastest, Medium the most accurate. *Audio language*: leave it on
   "Auto-detect" unless you know it. *Translate to*: optional, to get the captions in another language.
   *Clean up background noise* (off by default): turn it on when music or loud noise covers the voice. It takes longer,
   because the voice is isolated before transcribing. If it cannot be done, the job continues with the original audio and
   the result says so ("Audio cleaned: No"); when applied it shows "Audio cleaned: Yes".
   *Identify who is speaking* (off by default): labels each caption with who says it, useful for interviews and
   meetings. It takes longer and is only enabled if the server has a Hugging Face token (see "Turning on speaker
   identification"). If it cannot be done, the job delivers the normal transcription and the result says so
   ("Speakers identified: No").
3. **Generate the captions.** Press "Generate captions". You will see the upload and then the job stages (preparing the
   audio, transcribing, translating…). With several videos they are uploaded one at a time; if one fails the queue stops
   there and what was already uploaded is kept. You can close the page: the job keeps running on the server and stays in
   "Recent".
4. **Review and fix.** Edit the text and timing of each caption. Save with "Save changes" or Ctrl+S. If the captions
   changed while you were editing (another tab, another person) the page warns you and lets you choose between loading
   the new version or saving your changes on top. If speakers were identified, each caption shows who is speaking
   (with a colour) and the "Speakers" panel lets you rename them: the change applies to all of their captions and
   is saved with the rest.
5. **Download.** The `.srt` works in almost any player and editor; the `.vtt` is for the web. Save your changes first so
   the `.srt` includes them. With speakers, the "Put the speaker's name before the text" checkbox adds "Name: " to
   the `.srt` and the `.vtt`.
6. **Put the captions on the video.** Pick a style (Modern, TikTok, YouTube, Minimal) and, if the video has word timings,
   turn on karaoke. "Create video with captions" starts a separate job; when it finishes you can watch it on the page and
   download it.

## Good to know

- Results are **deleted from the server after a day**. "Recent" only stores identifiers in this browser, not videos.
- The web interface uses the API key from `.env` (`DEFAULT_API_KEY`, created by `start.sh` / `start.bat`) and sends it by
  itself. If you see "This interface's access key is missing, invalid or was revoked", check that variable and restart the
  service (ADR 0015).
- Jobs belong to whoever holds the key: with another key they are not visible (nor can they be cancelled, edited or downloaded).
- The captioned video is previewed in the page only up to 256 MiB; above that, the download still works.
- Keyboard: everything works with Tab/Enter/Space; Ctrl+S saves changes; important notices are announced to screen
  readers.

## Turning on speaker identification

It is optional and done by the server, not the browser. Whoever runs the server needs:

1. A free account at <https://huggingface.co> and, signed in, to accept the terms of the models
   <https://huggingface.co/pyannote/speaker-diarization-3.1> and
   <https://huggingface.co/pyannote/segmentation-3.0> (one button on each page; acceptance is immediate).
2. A token from <https://huggingface.co/settings/tokens> → *Create new token* → type **Read** (read-only).
3. The token ONLY in the worker's environment: `HF_TOKEN=hf_...` in the Docker Compose `.env`, or
   `HF_TOKEN_FILE=path/to/file` (a file holding the token or a line `HF_TOKEN=...`). The API does not get the
   token; it only knows the feature is available (`GET /v1/capabilities`) and the web enables the checkbox.
4. The worker built with the component: `docker build --build-arg WITH_DIARIZATION=1 …` (or install
   `apps/ai-worker/requirements-diarization.txt`). The model (~100 MB) downloads the first time.

Never paste the token into a chat, an issue or a commit. If it leaks, revoke it on the same tokens page.

## When something goes wrong

| Symptom | What to do |
|---|---|
| "The server is busy. Retry in N s." | That is the per-minute upload limit: wait for the countdown, then use the retry button. |
| "These captions are no longer on the server" | More than a day has passed: upload the video again. |
| Uploading a huge file ends in a network error | The server rejects it before receiving it if it exceeds the maximum; check the size shown on the upload area. |
| "The background noise could not be removed…" in the result | Voice separation failed (for example, no GPU memory or the component is not installed) and the original audio was transcribed: review the captions more carefully or try without the option. |
| The "Identify who is speaking" checkbox is disabled | The server has no Hugging Face token or the component is not installed: see "Turning on speaker identification". |
| "Who is speaking could not be identified…" in the result | Identification failed (token without access or revoked, no network, out of memory or timed out) and the normal transcription was delivered. Check that you accepted the terms of both models and try again. |
| Two tabs editing the same captions | The second one to save sees the conflict notice (nothing is lost without your decision). |
