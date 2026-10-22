# CaptionForge

**English** | [Español](README.es.md)

[![Monorepo CI](https://github.com/Bryandero98/captionforge/actions/workflows/monorepo.yml/badge.svg)](https://github.com/Bryandero98/captionforge/actions/workflows/monorepo.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Free automatic video captions - transcription, translation and burned-in
subtitles - without a watermark or a monthly limit, and today without an account.
CaptionForge started as a local, single-process tool and is now being rebuilt as an
**event-driven distributed service** designed to withstand failures and load: explicit
caps, graceful shutdown and recovery of orphaned jobs. Its known limits are declared, not hidden.

- **Transcription** with [faster-whisper](https://github.com/SYSTRAN/faster-whisper),
  **translation** to any language with [argos-translate](https://github.com/argosopentech/argos-translate),
  and **burned-in subtitles** with [ffmpeg](https://ffmpeg.org/) in four caption styles
  (Modern, TikTok bold, YouTube classic, Minimal), with optional word-by-word karaoke.
- **Output** as `.srt` (plus `.vtt` and `.ass` in the local package), or the video with the captions burned in.
- **Editable**: fix text and retime segments before burning; a stale edit is rejected (`409`)
  instead of silently overwriting someone else's.
- **Live progress** over Server-Sent Events, not polling.

> **Two ways to run it**
>
> | | What it is | Status |
> |---|---|---|
> | **Local package** | `pip install` + `captionforge serve` (Python 3.10+): one process, one video at a time, nothing leaves your machine. | Published on PyPI. See [`legacy/`](legacy/README.md). |
> | **Service (this monorepo)** | API Gateway + queue + AI Worker + object storage, built to run several jobs and several users. | API and worker done; web client feature-complete (upload queue, live progress, editor, downloads, burned-in video; 6 languages), user accounts pending. |

## Quickstart (service)

Requirements: Docker, Node >= 22 and Python >= 3.11.

```sh
npm install
cp .env.example .env        # fill in every value (see the note below)
npm run infra:up            # PostgreSQL, Redis and S3 (RustFS)
npm run infra:verify        # permissions: what is allowed works, what is forbidden fails
```

Generate a secret with `node -e "console.log(require('crypto').randomBytes(18).toString('hex'))"`.
Secrets live in `.env` (ignored by git), never in the repository.

The contract and smoke-test commands need their Python environments, created once:

```sh
python -m venv packages/contracts/.venv
packages/contracts/.venv/bin/python -m pip install -r packages/contracts/requirements-dev.txt
python -m venv tools/smoke/.venv
tools/smoke/.venv/bin/python -m pip install -r tools/smoke/requirements.txt
```

(on Windows, `Scripts\python.exe` instead of `bin/python`).

`api-gateway` and `ai-worker` run **natively** against the dockerized infrastructure in local
development, to save RAM. For a full deployment:

```sh
docker compose --profile app up -d --build
docker compose ps           # health of every service
npm run e2e                 # uploads a video, transcribes it, edits a caption, burns it, downloads the MP4
docker compose --profile app down   # turn everything off when you are done (`npm run infra:down` stops only the infrastructure)
```

### Try it

```sh
# Create a transcription job (the `options` JSON part goes before `file`;
# modelSize: base | small | medium, translateTo: a language code or null)
curl -F 'options={"modelSize":"base","translateTo":"es"}' -F file=@clip.mp4 http://127.0.0.1:3000/v1/jobs/transcribe
# -> 202 { "id": "..." }

# Follow it live (Server-Sent Events) and read the result
curl -N http://127.0.0.1:3000/v1/jobs/<id>/events
curl -OJ http://127.0.0.1:3000/v1/jobs/<id>/artifacts/srt
```

With `API_KEY` set, add `-H "Authorization: Bearer <key>"` to every call.

## API

Everything hangs off `/v1/jobs`. The worker writes the job state in PostgreSQL and the API reads
it. With `API_KEY` set (see `.env.example`) every route requires `Authorization: Bearer <key>`;
`/health` stays open.

| Method and route | What it does |
|---|---|
| `POST /v1/jobs/transcribe` | Multipart. Streams the video to S3 as it arrives. `202` |
| `GET /v1/jobs/:id` | State, stage, percentage, error and result |
| `GET /v1/jobs/:id/events` | Progress over SSE until a final state |
| `POST /v1/jobs/:id/cancel` | Cancels: removed from the queue, or the worker is told to stop |
| `GET /v1/jobs/:id/segments` | Captions with `index` and the current `etag` |
| `PUT /v1/jobs/:id/segments` | Edits text and/or timing by index (`etag` optional: `409` if they changed) |
| `POST /v1/jobs/:id/burn` | Burns the current captions: `{ "style": "modern", "karaoke": false }`. `202` |
| `GET /v1/jobs/:id/artifacts/:name` | `srt`, `segments`, `waveform` (transcription) or `video` (burn); supports `Range` |

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-dark.svg">
  <img src="docs/architecture-light.svg" alt="Diagram: a browser uploads a video to the NestJS API Gateway, which streams it to S3, records the job in PostgreSQL and enqueues it in Redis/BullMQ. A Python AI worker takes the job, reads and writes artifacts in S3, updates the job state in PostgreSQL with conditional transitions, and the gateway relays progress back to the browser over Server-Sent Events.">
</picture>

Two processes that share neither disk nor memory: an **API Gateway** that talks to people and an
**AI Worker** that does the heavy work (Whisper, ffmpeg, translation). They talk through a queue
(Redis/BullMQ) and an object store (S3); the message contracts are versioned JSON Schemas, and
files are referenced by `bucket` + `objectKey`, never by URL. Each service has the least privilege
that works: separate database roles and S3 policies, so a compromised worker cannot drop tables or
leave `jobs/`.

```text
apps/
  api-gateway/       NestJS 12 + Fastify + Prisma: uploads to S3, queue, SSE, cancellation, captions, burn
    src/security/      Host/Origin guard, concurrency limiter, client key
    src/storage/       streaming multipart upload to S3
  ai-worker/         Python: BullMQ consumer, Whisper, translation, ffmpeg; state straight to PostgreSQL
packages/
  contracts/         JSON Schemas (source of truth) + generated TypeScript types and Pydantic models
docker/              PostgreSQL roles, S3 buckets and policies, the permission check
tools/
  smoke/             Node -> Redis -> Python contract test with real BullMQ
  e2e/               end-to-end run against the full containerized stack
legacy/              the published local pip package (CLI + local web server)
docs/
  adr/               why each decision was made
  architecture.md    components, who can do what, worker rules, phases
  architecture_and_security.md   security posture and resilience, with declared limits
```

### Security and resilience

Designed so the failure mode is "refuse, cut off or do nothing" rather than "run unchecked":

- **Browser-origin attacks:** fail-closed `Host` / `Origin` / `Sec-Fetch-Site` guard and a closed
  CORS list against CSRF and DNS rebinding ([ADR 0011](docs/adr/0011-origen-y-host-fail-closed-contra-paginas-ajenas.md)).
- **Bounded memory and sockets:** uploads stream to S3 in 5 MiB parts with total and per-client
  caps and a minimum rate; SSE streams have a global cap, a per-client cap and a maximum duration.
- **Secrets stay out of subprocesses:** ffmpeg runs with an allow-listed environment.
- **Graceful shutdown:** the worker lets the running job finish within a grace period, then asks it
  to stop and closes it as failed, and cleans its ephemeral `/work` volume, including leftovers
  from a crash at startup.
- **Supply chain:** GitHub Actions pinned by SHA, read-only workflow permissions checked in CI,
  and a release workflow built for PyPI Trusted Publishing (OIDC), with no long-lived token in
  the workflow.

The full picture, including what is **not** covered yet, is in
[docs/architecture_and_security.md](docs/architecture_and_security.md).

## Commands

| Command | What it does |
|---|---|
| `npm run contracts:gen` / `contracts:check` / `contracts:test` | Regenerate the TypeScript types and Pydantic models; fail if they drift (used in CI); test both with the same examples |
| `npm run infra:up` / `infra:down` | Start or stop PostgreSQL, Redis and S3 |
| `npm run infra:verify` | Permission check: allowed works, forbidden fails |
| `npm run smoke` | Node producer -> Redis -> Python worker with real BullMQ |
| `npm run infra:logs` | Follow the logs of the infrastructure |
| `npm run migrate -w @captionforge/api-gateway` | Apply Prisma migrations with the owner role (`cf_owner`) |
| `npm test -w @captionforge/api-gateway` | API tests against real PostgreSQL, Redis and S3 |
| `npm run worker:test` | Worker tests with ffmpeg, PostgreSQL, Redis and S3 (Whisper faked; `WHISPER_E2E=1` uses the real one) |
| `npm run e2e` | End to end against the full containerized stack (downloads the model the first time) |
| `npm run workflows:check` | Fails if a workflow lacks read-only permissions or an action is not pinned by SHA |
| `npm run compose:check` | Validates `docker-compose.yml` with and without the `app` profile |

## Status and roadmap

| Phase | Content | State |
|---|---|---|
| 0-3 | Monorepo, contracts, infrastructure, API Gateway, AI Worker | Done |
| 4a | Caption editing, burn queue, download with `Range` | Done |
| 5a | Hardening: limits, orphaned jobs, Host/Origin guard, supply chain | Done |
| **4b** | **Web client on the new API** (REST, async multipart upload, live SSE) | **Done** — [user guide](docs/user-guide.md) · [guía de uso](docs/guia-de-uso.md) |
| 5b | User accounts, ownership of jobs, observability, deployment | Pending |

After the web client, ideas worth doing, deliberately not started:

- **Speaker diarization** ("who said what") via [pyannote.audio](https://github.com/pyannote/pyannote-audio) - [issue #4](https://github.com/Bryandero98/captionforge/issues/4).
- **Vocal/source separation** before transcription for noisy audio - [issue #5](https://github.com/Bryandero98/captionforge/issues/5).
- **A complete native installer** for the local package (multi-platform, signed, ffmpeg bundled) - [issue #2](https://github.com/Bryandero98/captionforge/issues/2); a first step exists in [`legacy/`](legacy/README.md).
- **Isolating ffmpeg** in its own user or container (the minimal environment prevents accidental
  secret inheritance, not an already-compromised ffmpeg).

## Decisions

The reasoning lives in [docs/adr/](docs/adr): JSON Schema contracts, `objectKey` instead of URLs,
BullMQ with a Python worker, Python writing straight to PostgreSQL, S3 storage with RustFS, worker rules, local development,
the NestJS API, why the worker reuses `legacy/` instead of copying it, API hardening, and the
fail-closed Host/Origin guard. The technical documents (ADRs, architecture) and the API's
error messages are in Spanish.

## Contributing

Suggestions for what CaptionForge should do next are welcome, not just bug reports - open an
issue with what you would want, even a rough one. See [CONTRIBUTING.md](CONTRIBUTING.md) for how
to send a PR.

## Support this project

CaptionForge is free by design and will stay that way. A tip unlocks nothing; it goes toward
eventually paying for a real host, so people who do not want to install anything have a
"no-install-at-all" option too:

- **Ko-fi:** [ko-fi.com/bryandero98](https://ko-fi.com/bryandero98)
- **USDT (TRC20):** `TEG4Kk2qXYMQ4mHNd7dPhSPRyT14CGr2or` - double-check the network is set to
  **TRC20** before sending; a transfer on the wrong network cannot be recovered.

## License

[MIT](LICENSE)
