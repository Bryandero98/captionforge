"""Modelos de Whisper: comprobar/descargar y mantener UNO cargado en memoria (ADR 0006, regla 8)."""

from __future__ import annotations

import threading
from collections.abc import Callable

from captionforge.models import assert_model_fits, download_model_with_progress, is_model_cached
from captionforge.pipeline import select_device


class ModelProvider:
    """Carga el modelo una vez por proceso y lo reutiliza; al cambiar de tamaño libera el anterior.

    Todos los métodos son bloqueantes: se llaman con asyncio.to_thread.
    """

    def __init__(
        self,
        loader: Callable[[str], tuple[object, str]] = select_device,
        is_cached: Callable[[str], bool] = is_model_cached,
        fits: Callable[[str], None] = assert_model_fits,
        download: Callable[[str, Callable[[int, int], None]], None] = download_model_with_progress,
    ) -> None:
        self._loader = loader
        self._is_cached = is_cached
        self._fits = fits
        self._download = download
        self._lock = threading.Lock()
        self._size: str | None = None
        self._model: object | None = None
        self._device = "cpu"
        self.loads = 0  # cuántas veces se cargó realmente (las pruebas comprueban que es 1)

    def is_cached(self, size: str) -> bool:
        return self._is_cached(size)

    def download(self, size: str, on_progress: Callable[[int, int], None]) -> None:
        self._fits(size)
        self._download(size, on_progress)

    def get(self, size: str) -> tuple[object, str]:
        with self._lock:
            if self._model is None or self._size != size:
                self._model = None  # libera el anterior antes de cargar el nuevo
                self._model, self._device = self._loader(size)
                self._size = size
                self.loads += 1
            return self._model, self._device
