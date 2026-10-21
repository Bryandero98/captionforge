"""Finds the ffmpeg executable CaptionForge should run.

Captions are the whole point of the app (transcribe, translate, burn), so ffmpeg
is not optional - and the burn step needs a build with libass (the `subtitles`
filter), which a system ffmpeg does not always have (plain Homebrew ffmpeg on
macOS, for one). Search order:

1. `CAPTIONFORGE_FFMPEG` - an explicit path, for anyone who wants their own build.
2. The ffmpeg shipped with the `imageio-ffmpeg` dependency (known to include libass).
3. `ffmpeg` on the PATH.

Anything that is skipped on the way (a bad override, a missing or broken bundled
binary) is logged as a warning rather than swallowed: falling through silently
would leave the user running a different ffmpeg than they think.

ffmpeg_utils.py stays pure and keeps writing the bare name "ffmpeg" in every argv;
callers that actually run a process pass the argv through `with_ffmpeg_path` first.
"""

from __future__ import annotations

import logging
import os
import shutil

ENV_VAR = "CAPTIONFORGE_FFMPEG"

MISSING_MESSAGE = (
    "No se encontro ffmpeg. Instala el incluido con `pip install imageio-ffmpeg`, o define "
    f"{ENV_VAR} con la ruta completa de tu ffmpeg (PowerShell: $env:{ENV_VAR}='C:\\ruta\\ffmpeg.exe'; "
    f"Linux/macOS: export {ENV_VAR}=/ruta/ffmpeg)."
)

logger = logging.getLogger(__name__)


def _usable(path: str) -> bool:
    return os.path.isfile(path) and os.access(path, os.X_OK)


def find_ffmpeg() -> str | None:
    override = os.environ.get(ENV_VAR)
    if override:
        if _usable(override):
            return override
        logger.warning(
            "%s=%r no es un archivo ejecutable (debe ser la ruta completa, sin comillas); se ignora.",
            ENV_VAR,
            override,
        )

    bundled: str | None = None
    try:
        import imageio_ffmpeg

        bundled = imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError as exc:
        logger.warning("ffmpeg incluido no disponible (imageio-ffmpeg no esta instalado): %s", exc)
    except Exception as exc:  # noqa: BLE001 - e.g. no binary for this platform; we still want the PATH fallback
        logger.warning("ffmpeg incluido no disponible: %s", exc)
    if bundled:
        if _usable(bundled):
            return bundled
        logger.warning("El ffmpeg incluido (%s) no existe o no es ejecutable.", bundled)

    system = shutil.which("ffmpeg")
    if system:
        logger.warning(
            "Usando el ffmpeg del PATH (%s): puede no incluir libass, necesario para grabar subtitulos.",
            system,
        )
    return system


# Variables que ffmpeg (y libass/fontconfig, para grabar subtitulos) necesita para arrancar y encontrar
# tipografias. Todo lo demas -credenciales de PostgreSQL, S3, Redis, tokens- se queda fuera: ffmpeg decodifica
# archivos que sube cualquiera, y un fallo en un decodificador no debe regalarle los secretos del worker.
_FFMPEG_ENV_ALLOWED = frozenset(
    {
        # Windows y busqueda de ejecutables
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "SYSTEMDRIVE",
        "PROGRAMDATA",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "TMP",
        "TMPDIR",
        "HOME",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",  # cache de fontconfig
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_DATA_DIRS",
        "FONTCONFIG_FILE",
        "FONTCONFIG_PATH",
        "LANG",
        "LANGUAGE",
        "LC_ALL",
        "LC_CTYPE",
        "TZ",
    }
)


def ffmpeg_env() -> dict[str, str]:
    """Entorno minimo para el subproceso de ffmpeg: solo lo de `_FFMPEG_ENV_ALLOWED` (lista blanca).

    Limite conocido: protege contra la herencia accidental, no contra un ffmpeg ya comprometido que corra con
    el mismo usuario (podria leer /proc/<padre>/environ). Eso exige otro usuario o contenedor para ffmpeg.
    """
    # Windows guarda los nombres en mayusculas y no distingue; en Linux/macOS si, y "path" no es "PATH".
    fold = (lambda name: name.upper()) if os.name == "nt" else (lambda name: name)
    return {name: value for name, value in os.environ.items() if fold(name) in _FFMPEG_ENV_ALLOWED}


def with_ffmpeg_path(cmd: list[str]) -> list[str]:
    """Returns `cmd` with its first element (the bare "ffmpeg") replaced by the resolved executable."""
    exe = find_ffmpeg()
    if exe is None:
        raise FileNotFoundError(MISSING_MESSAGE)
    return [exe, *cmd[1:]]
