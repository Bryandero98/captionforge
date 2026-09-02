"""Local, offline translation of already-transcribed Segments via argos-translate.

Deliberately separate from Whisper: faster-whisper only transcribes in the
spoken language (with real timestamps); this module translates the *text* of
each already-timed Segment afterward, reusing its start/end/words unchanged -
translating text never changes when it was said. This is what makes any
language pair possible (including translating to Spanish), unlike Whisper's
own task="translate", which only ever translates into English.
"""

from __future__ import annotations

import os
from dataclasses import replace

from .srt import Segment

# argostranslate defaults to compute_type="auto" (ARGOS_COMPUTE_TYPE), which
# ctranslate2 resolves to a quantized int8/int8_float32 kernel on this CPU -
# verified live to silently produce garbage, repetition-loop output for the
# es->en 1.9 package (e.g. "Hola" -> "mainstremainstremainstre...") with no
# error raised. float32 (no quantization) was verified correct for the same
# input/model/hardware. Read once, at import time, by argostranslate's own
# settings module - must be set before argostranslate is ever imported
# anywhere in the process, hence this module-level line. setdefault() so an
# environment that's explicitly opted into quantization (and verified it
# works for its own model) isn't silently overridden.
os.environ.setdefault("ARGOS_COMPUTE_TYPE", "float32")


def _get_translation(from_code: str, to_code: str):
    import argostranslate.translate

    installed_languages = argostranslate.translate.get_installed_languages()
    source = next((lang for lang in installed_languages if lang.code == from_code), None)
    target = next((lang for lang in installed_languages if lang.code == to_code), None)
    if source is None or target is None:
        return None
    return source.get_translation(target)


def _ensure_language_pair_installed(from_code: str, to_code: str) -> None:
    if _get_translation(from_code, to_code) is not None:
        return

    import argostranslate.package

    # The first request for a given language pair downloads its model and
    # blocks the calling thread for a while - logged explicitly so this
    # doesn't read as a hang to whoever's watching the console.
    print(f"Descargando modelo de traducción {from_code}->{to_code}...")
    argostranslate.package.update_package_index()
    available_packages = argostranslate.package.get_available_packages()
    package = next(
        (p for p in available_packages if p.from_code == from_code and p.to_code == to_code),
        None,
    )
    if package is None:
        raise ValueError(f"No hay un paquete de traducción disponible para {from_code}->{to_code}.")
    argostranslate.package.install_from_path(package.download())


def translate_segments(segments: list[Segment], from_code: str, to_code: str) -> list[Segment]:
    """Returns new Segments with translated text; start/end/words are copied through unchanged."""
    if from_code == to_code:
        return segments

    _ensure_language_pair_installed(from_code, to_code)
    translation = _get_translation(from_code, to_code)
    if translation is None:
        raise RuntimeError(
            f"No se pudo cargar el modelo de traducción {from_code}->{to_code} tras instalarlo."
        )

    # `words` drops on translation: it holds the ORIGINAL-language word text
    # and per-word timing, which no longer lines up with the translated text
    # (different words, different count, often different order). Keeping it
    # would silently feed a future karaoke renderer mismatched word/timing
    # pairs under translated text - `None` is the honest "not available" answer.
    return [replace(segment, text=translation.translate(segment.text), words=None) for segment in segments]
