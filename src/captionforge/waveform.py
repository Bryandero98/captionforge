"""Downsampled audio amplitude data for the segment-editing screen's waveform backdrop.

Extracted straight from a job's ORIGINAL video (not the extracted-audio temp
file pipeline.py uses for transcription, which is deleted once transcription
finishes - see pipeline.py's `with tempfile.TemporaryDirectory()`) via a
single ffmpeg decode+resample pass to raw unsigned 8-bit PCM (see
ffmpeg_utils.build_waveform_extract_cmd), piped straight to this process's
stdout - no intermediate file, no separate audio-analysis dependency.

Deliberately NOT a precise amplitude/RMS analysis: this is a visual backdrop
for dragging segment start/end handles against, not a mastering tool - u8
PCM at a low, fixed sample rate (WAVEFORM_SAMPLE_RATE_HZ) and a simple
per-bucket max are more than enough resolution for that job, at a fraction
of the CPU/memory a proper analysis would cost.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from .ffmpeg_utils import WAVEFORM_SAMPLE_RATE_HZ, build_waveform_extract_cmd

# Hard cap on points actually returned - keeps the JSON response (and the
# frontend's render) small regardless of video length. An hour-long video at
# WAVEFORM_SAMPLE_RATE_HZ (100) decodes to 360,000 raw samples; downsampled to
# this cap it's still a smooth-looking waveform, just at coarser resolution.
MAX_PEAKS = 2000

_SILENCE = 128  # u8 PCM's zero-amplitude midpoint - every sample is compared against this.


class WaveformExtractionError(RuntimeError):
    """Raised when ffmpeg fails to decode video_path's audio track for the waveform."""


def _downsample_peaks(samples: bytes, max_peaks: int) -> list[float]:
    """Buckets raw u8 samples down to at most max_peaks amplitude values (each 0..1).

    Each bucket's peak is its single LOUDEST sample (max deviation from
    silence), not an average - a brief loud syllable inside an otherwise
    quiet bucket still shows up, instead of being smoothed away by whatever
    quiet surrounds it.
    """
    total = len(samples)
    if total == 0:
        return []
    if total <= max_peaks:
        return [abs(b - _SILENCE) / _SILENCE for b in samples]

    bucket_size = total / max_peaks
    peaks = []
    for i in range(max_peaks):
        start = int(i * bucket_size)
        end = max(int((i + 1) * bucket_size), start + 1)
        peaks.append(max(abs(b - _SILENCE) for b in samples[start:end]) / _SILENCE)
    return peaks


def compute_waveform_peaks(video_path: Path) -> tuple[list[float], float]:
    """Returns (peaks, duration_seconds) for video_path's audio track.

    Synchronous (subprocess.run, not asyncio) - meant to be called via
    asyncio.to_thread from the route handler, same posture as every other
    CPU/IO-bound call in this codebase that isn't itself async-native.
    `duration` is derived from the raw decoded sample count (samples /
    WAVEFORM_SAMPLE_RATE_HZ), the same "no separate probe call" approximation
    posture pipeline.py's own burn-progress duration estimate already uses -
    not a byte-exact ffprobe duration, just enough to scale the frontend's
    waveform pixels back to real seconds.
    """
    cmd = build_waveform_extract_cmd(str(video_path))
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        stderr_tail = result.stderr.decode(errors="replace")[-400:]
        raise WaveformExtractionError(f"ffmpeg no pudo leer el audio para el waveform: {stderr_tail}")

    samples = result.stdout
    duration = len(samples) / WAVEFORM_SAMPLE_RATE_HZ
    return _downsample_peaks(samples, MAX_PEAKS), duration
