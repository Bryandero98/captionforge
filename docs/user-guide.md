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
   and AVI (plus M4V, 3GP, MPEG, WMV, FLV and OGV), or audio: MP3, WAV, M4A, OGG, FLAC, OPUS, AAC, AMR, WMA, AIFF and WEBA (see "Audio"). Files that cannot be used are skipped and the reason is shown.
2. **Read the summary (Quick mode).** When you choose a file, the page reads its duration and shape in your browser (nothing is
   uploaded) and tells you what it will do in one line, for example "Profile: Vertical (Shorts/Reels) · Model: Small · Then: vertical
   9:16 video". If the file looks like a Short, a podcast, a meeting or a clip, it suggests that profile with the reason; you can
   "Change" the profile or "Dismiss" the suggestion. If it looks right, press "Generate captions" and you are done. With the
   profiles that burn the captions (Vertical and Quick clip) the tab requests the captioned video by itself when the transcription
   finishes: **keep the tab open** (if you close it, the transcription keeps running on the server and you can create the
   video by hand from the result). To adjust things yourself, open **"Full control"** (it always starts folded):
   *Model*: Base is the fastest, Medium the most accurate. *Audio language*: leave it on
   "Auto-detect" unless you know it. *Translate to*: optional, to get the captions in another language.
   *Clean up background noise* (off by default): turn it on when music or loud noise covers the voice. It takes longer,
   because the voice is isolated before transcribing. If it cannot be done, the job continues with the original audio and
   the result says so ("Audio cleaned: No"); when applied it shows "Audio cleaned: Yes".
   *Identify who is speaking* (off by default): labels each caption with who says it, useful for interviews and
   meetings. It takes longer and is only enabled if the server has a Hugging Face token (see "Turning on speaker
   identification"). If it cannot be done, the job delivers the normal transcription and the result says so
   ("Speakers identified: No").
   What you set in "Full control" is remembered in this browser (settings only, never keys or file names);
   "Reset preferences" erases it.
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
7. **Translate or dub (optional).** With a finished transcription and your changes saved, "Translate the captions" and
   "Dub with a synthetic voice" create separate jobs. Translating works without an external account; dubbing needs a
   provider key saved by the Owner. See the next sections.

## Audio: podcasts, voice notes and recordings

You can also upload **audio with no video**: MP3, WAV, M4A, OGG, FLAC, OPUS (voice notes), AAC, AMR, WMA, AIFF and WEBA. It is transcribed just like a video and, in addition:

- An **audio player** with the original file appears so you can listen while you fix the captions. If the original has already
  expired, the player does not appear and everything else keeps working.
- **There is no "Burn the captions into the video"**: audio has no picture. Download the `.srt` or the `.vtt`.
- **Translate** works the same (local engine or OpenAI with your key): you get the translated text.
- **Dub** delivers only the **voice track as an `.mp3`** in the chosen language (it is translated first, then dubbed). The output
  menu is fixed to "Voice track only (.mp3)": there is no video to mix into.

So the same audio can become translated text (translate) or come back as audio in another language (dub).

## External keys (Owner only)

"Dub" and translating with OpenAI use **your own account** at OpenAI or ElevenLabs (BYOK, *bring your own key*). CaptionForge
does not bill that compute: your provider does, at your account's price. Keys are stored per workspace
(ADR [0020](adr/0020-ia-avanzada-y-claves-externas-byok.md)).

1. Sign in (`LOCAL_MODE=false`) as an **Owner** of the workspace. The **External keys** button in the top bar only appears for
   the Owner.
2. Create an API key in your [OpenAI](https://platform.openai.com/api-keys) or ElevenLabs account.
3. Paste it in the provider's field and press **Save**. To change it, paste the new one and press **Replace**. To remove it,
   press **Delete** and confirm by pressing again.

Good to know:

- The key is stored encrypted and **never shown again**: the list only shows "Saved: …" with its last 4 characters. If you
  lose it, paste it again.
- Only the Owner, signed in, saves, replaces or deletes. The **Editor uses** the keys when launching jobs without seeing
  them; the **Viewer** does not launch jobs. Workspace API keys cannot manage them either.
- Keys belong to the workspace, not to a person: if you stop being an Owner, they stay in use for the team.
- A key must have the provider's format (OpenAI keys start with `sk-`) and be 20 or more characters; otherwise it is rejected
  without repeating what you pasted.
- Never paste a key into a chat, an issue or a commit. If it leaks, revoke it in your provider's dashboard and paste another.
- If the server does not have the feature on (no `APP_SECRET`), there is no panel and "Dub" is blocked. Whoever runs the
  server turns it on following the [`APP_SECRET` runbook](runbook-app-secret.md).

### Other OpenAI-compatible AI services: DeepSeek, Groq, OpenRouter, local models

The OpenAI row has two optional fields, **Base URL (compatible API)** and **Model**. With them, translation uses another service
that speaks the same protocol as OpenAI, with your own key for that service (ADR [0022](adr/0022-url-base-propia-para-proveedores-de-ia.md)).

| Service | Base URL | Example model |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` |
| Gemini (compatible layer) | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |
| Ollama on your machine* | `http://localhost:11434/v1` | `llama3.1:8b` |

Check each service's documentation for the current URL and model names; the table shows examples. Left empty, OpenAI is used
with its default model (`gpt-4o-mini`).

- The **URL is never shown again**: it is stored encrypted and the list only shows the server ("Server: api.deepseek.com"). When
  you replace the key you must enter it again; a replacement without a URL goes back to OpenAI. The model is shown and offered again.
- Only **public servers over https** are accepted. The worker resolves DNS before every request and, if the name points to a
  private network, cancels the job **without sending the key**.
- \* To use a local model (Ollama, vLLM) whoever runs the server sets `ALLOW_PRIVATE_BASE_URLS=true` in `.env` (off by default).
  Local and private addresses are then accepted, also over http. Cloud metadata addresses (`169.254.x.x`) stay blocked always.
  From Docker, an Ollama on your machine is reached at `http://host.docker.internal:11434/v1`.
- The spend confirmation and the "Translate" estimate show the server and model you configured.

## Subtitle quality

Below the transcription facts is the **Subtitle quality** panel. Pick a **standard** (Netflix in English or Spanish, BBC, Accessible or Vertical shorts) and press **Check**: it tells you which captions read too fast, have long lines, are too short or too long, or sit too close to (or overlap) the previous one, and by how much. Each notice states its severity in words (Error, Warning, Suggestion).

- Each standard says how far it was checked against its official guide. It is a measurement, not a certification.
- **Suggest a fix** (Editor or Owner) shows what would change before touching anything: only each caption's end time and the line breaks; **the text is never modified**. **Apply the fix** saves it and checks again; **Discard** changes nothing.
- What cannot be solved without changing the text (for example, a sentence too long to read in time) stays as pending for you to decide.
- If you have unsaved changes in the editor, save or discard them first.

## Translate the captions

1. With the transcription finished and **no unsaved changes** (if there are, the button is disabled and the page says why),
   open "Translate the captions".
2. Under *Engine* pick **On this machine (free)**, which uses Argos on the server, or **OpenAI (with your key)**, which needs the
   OpenAI key saved by the Owner. Under *Translate to* pick the target language, which must differ from the detected one.
3. Press **Translate**. With OpenAI the [spend confirmation](#spend-confirmation-and-limits) appears first.
4. When it finishes, download the **translated .srt** or **translated .vtt**. The translation is a separate job: the original
   captions do not change.

Only one translation can run per transcription; wait for it to finish or cancel it.

## Dub with a synthetic voice

1. With the transcription finished and your changes saved, open "Dub with a synthetic voice".
2. *Voice from*: OpenAI or ElevenLabs. Under *Voice* type the OpenAI voice name (for example `alloy`, `nova` or `onyx`; `alloy`
   is suggested) or paste the ID of a voice from your ElevenLabs account.
3. *Text to dub*: the original captions or a finished translation.
4. *Output*: the voice track only (`.mp3`), the video with the dubbed voice **instead of** the original audio (`replace`), or
   the video with the original audio **lowered** under the voice (`duck`).
5. Press **Dub**, confirm the spend and download the **audio (.mp3)** or the **dubbed video (.mp4)** when it finishes.

How the voice fits the timing: each phrase is sped up or slowed down between 0.85x and 1.25x to fit its slot, and two voices
never overlap. If a phrase does not fit even at maximum speed-up, it ends later than planned and the result warns you
("N phrases do not fit their time…"): shorten that caption or accept the offset. Blank segments are neither sent nor billed.
Only one dub can run per transcription.

## Spend confirmation and limits

Before sending text to an external provider, the page opens a dialog: "This operation uses your OpenAI account. Estimate:
≈ N characters (≈ M tokens). Your provider does the billing and it cannot be undone." Focus starts on **Cancel** and Esc also cancels, so
Enter cannot spend by accident. Local translation does not ask, because it costs nothing.

For reference (the same table is in the page's guide and under "External keys"):

| Length of speech | Characters sent to the AI | Approx. tokens |
|---|---|---|
| 15 s | 200 | 50 |
| 30 s | 400 | 100 |
| 45 s | 600 | 150 |
| 60 s | 800 | 200 |

This is an estimate: 1 token ≈ 4 characters, and the AI's reply uses about as many tokens again, so count roughly double. Your
provider sets the price per token.

Each job has a limit of **50,000 characters** and **1,000 captions**, defaults that whoever runs the server adjusts with
`MAX_JOB_CHARACTERS` and `MAX_JOB_SEGMENTS`. If the text exceeds them, the server rejects it **before** asking the provider
for anything. There are no daily or monthly limits per workspace yet: total spend depends on your provider account, so it is
worth setting a spending limit there.

## In local mode

On a single-person install without sign-in (`LOCAL_MODE=true`, the default) BYOK is not offered: there is no "External keys"
button (saving keys requires being a signed-in Owner) and "Dub" is blocked with the explanation "this server does not have them
enabled (they are not available in local mode)". **Translating keeps working with the local engine (Argos)**, with no key and
no cost. To dub or to translate with OpenAI, use a server with sign-in (`LOCAL_MODE=false`).

## Good to know

- Results are **deleted from the server after a day**. "Recent" only stores identifiers in this browser, not videos.
- The web interface uses the API key from `.env` (`DEFAULT_API_KEY`, created by `start.sh` / `start.bat`) and sends it by
  itself. If you see "This interface's access key is missing, invalid or was revoked", check that variable and restart the
  service (ADR 0015). On a shared server with sign-in (`LOCAL_MODE=false`) you sign in with GitHub or Google instead, and create
  your own API keys from the **API keys** button (ADR 0016).
- Jobs belong to whoever holds the key: with another key they are not visible (nor can they be cancelled, edited or downloaded).
- **Teams** (shared server, ADR 0019): a workspace can have several people. **Owner** manages the team and the keys; **Editor** uploads
  and edits; **Viewer** only views and downloads. To invite, the Owner opens **Team**, picks the role and copies the link: it works once
  and expires in 7 days. Whoever opens it signs in (or signs up) and sees "Do you want to join this workspace?" with the workspace name and the role; they join by pressing **Join** (never automatically). If you belong to several workspaces,
  the selector in the top bar switches between them. The last Owner cannot be removed or demoted: promote someone else first.
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
| "The provider key is missing. A workspace Owner must save it first under “External keys”" (409, or the job fails with `EXTERNAL_KEY_MISSING`) | The workspace has no key saved for that provider. Ask an Owner to paste it under **External keys** and launch the job again. |
| "This server does not have your own external keys enabled" | The server has no `APP_SECRET`. Whoever runs it must set it (see the [runbook](runbook-app-secret.md)); in local mode the feature does not exist. |
| "The provider rejected the key…" (`EXTERNAL_AUTH_FAILED`) | The key is wrong, revoked or lacks permission. The Owner replaces it under **External keys**. It is not retried. |
| "Your provider account ran out of balance or hit its limit" (`EXTERNAL_QUOTA_EXCEEDED`) | Top up the account or raise its limit in the provider's dashboard and launch the job again. It is not retried. |
| "The provider is receiving too many requests" (`EXTERNAL_RATE_LIMITED`) | The server already retried with growing waits. Wait a few minutes and launch it again. |
| "The provider took too long" or "is not available" (`EXTERNAL_TIMEOUT`, `EXTERNAL_UNAVAILABLE`) | Temporary provider failure, after several retries. Try again later. If it happens on every job and the key was fine, tell whoever runs the server: it may be an `APP_SECRET` problem (see the [runbook](runbook-app-secret.md)). |
| "The text is too long for a single job" (413 or `JOB_TOO_LARGE`) | You exceed 50,000 characters or 1,000 captions (defaults). Split the video into parts. |
| "The captions are already in that language" | The target language equals the detected one: pick another. |
| "A translation (or dub) is already in progress…" | Only one per transcription. Wait for it to finish or cancel it. |
| "N phrases do not fit their time…" on a dub | The audio is delivered in full; those phrases end later than planned. Shorten them in the editor and dub again if sync matters. |
| Two tabs editing the same captions | The second one to save sees the conflict notice (nothing is lost without your decision). |
