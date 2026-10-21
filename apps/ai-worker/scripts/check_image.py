"""Comprobación de la imagen de despliegue: el worker, Whisper y ffmpeg trabajan juntos de verdad.

Se ejecuta DENTRO de la imagen (`docker run --entrypoint python IMAGEN -`, con este archivo por stdin).
Existe porque una versión nueva de PyAV (19) rompió `faster_whisper.audio.decode_audio` mientras todo lo
demás importaba bien: un `import` no basta, hay que decodificar audio de verdad.
"""

import os
import subprocess
import tempfile

import argostranslate.translate  # noqa: F401 - se importa de forma diferida en el worker
import captionforge_contracts  # noqa: F401
from captionforge.ffmpeg_locator import find_ffmpeg
from faster_whisper.audio import decode_audio

import ai_worker.worker  # noqa: F401

ffmpeg = find_ffmpeg()
assert ffmpeg, "no se encontró ffmpeg"
with tempfile.TemporaryDirectory() as folder:
    wav = os.path.join(folder, "silencio.wav")
    subprocess.run(
        [ffmpeg, "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "1", "-y", wav], check=True
    )
    samples = decode_audio(wav)  # la llamada que fallaba con PyAV 19
    assert len(samples) > 0, "decode_audio no devolvió muestras"
print("imagen correcta: ffmpeg y decode_audio funcionan")
