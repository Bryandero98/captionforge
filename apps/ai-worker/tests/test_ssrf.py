"""Guardia de regresión (hallazgo H5 de la revisión): un "video" que en realidad es una lista HLS no debe hacer
que el worker, dentro de la red interna, pida URLs.

Estado verificado con ffmpeg 7.1 (imageio-ffmpeg): NO es explotable hoy, por dos capas independientes. El worker
guarda la entrada siempre como `input.bin` (la extensión no la controla quien sube) y con ese nombre ffmpeg ni
siquiera detecta HLS, ni con la whitelist ampliada; y con la lista HLS bien nombrada (`.m3u8`) la whitelist por
defecto de un archivo local bloquea http, que solo se alcanza con `-protocol_whitelist` explícito (control positivo
hecho a mano). Este test falla si alguien cambia el nombre local o ensancha la whitelist."""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from ai_worker.errors import classify

from test_pipeline import run_job


class _Counting(BaseHTTPRequestHandler):
    hits: list[str] = []

    def do_GET(self) -> None:  # noqa: N802
        _Counting.hits.append(self.path)
        self.send_response(404)
        self.end_headers()

    do_HEAD = do_GET  # noqa: N815

    def log_message(self, *args: object) -> None:  # silencio
        pass


@pytest.fixture
def internal_server():
    _Counting.hits = []
    server = HTTPServer(("127.0.0.1", 0), _Counting)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_address[1], _Counting.hits
    server.shutdown()


def test_a_hls_playlist_disguised_as_mp4_cannot_make_ffmpeg_request_internal_urls(
    config, storage, fake_models, new_job, tmp_path, internal_server  # noqa: ANN001
) -> None:
    port, hits = internal_server
    _, payload = new_job(upload_input=False)
    playlist = tmp_path / "falso.mp4"
    playlist.write_text(
        f"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:{port}/interno/secreto.ts\n#EXT-X-ENDLIST\n"
    )
    storage.upload_file(playlist, payload["input"]["objectKey"], "video/mp4")

    with pytest.raises(Exception) as caught:  # noqa: PT011
        run_job(config, storage, fake_models, payload)

    assert classify(caught.value).code == "FFMPEG_FAILED"
    assert hits == [], f"ffmpeg hizo peticiones a la red interna: {hits}"
