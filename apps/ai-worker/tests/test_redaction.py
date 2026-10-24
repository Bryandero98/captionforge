"""La clave externa de un espacio (ADR 0020) vive solo en memoria y nunca sale en un log, una traza ni un mensaje de error."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import logging
import pickle
import urllib.parse

import pytest

from ai_worker.errors import JobFailure
from ai_worker.logfmt import JsonFormatter, configure_logging
from ai_worker.redaction import REDACTED, REDACTOR, RedactingFilter, Secret

KEY = "sk-canario-4f9a1c7e2b8d03a6f5e1c9b7d2a48e60"


@pytest.fixture(autouse=True)
def _limpio():
    """Cada prueba empieza y termina sin secretos registrados."""
    REDACTOR.clear()
    yield
    REDACTOR.clear()


def _record(message: str, *args: object, exc_info=None, level: int = logging.ERROR) -> logging.LogRecord:
    return logging.LogRecord("ai_worker", level, __file__, 1, message, args, exc_info)


class TestSecret:
    def test_no_se_ve_en_repr_str_ni_f_strings(self) -> None:
        secret = Secret(KEY)
        for text in (repr(secret), str(secret), f"{secret}", f"{secret!r}", "%s" % secret, "{}".format(secret), format(secret, ">40")):
            assert KEY not in text
            assert "canario" not in text

    def test_reveal_devuelve_el_valor(self) -> None:
        assert Secret(KEY).reveal() == KEY

    def test_no_se_serializa_ni_se_copia(self) -> None:
        secret = Secret(KEY)
        with pytest.raises(TypeError):
            pickle.dumps(secret)
        with pytest.raises(TypeError):
            copy.copy(secret)
        with pytest.raises(TypeError):
            copy.deepcopy(secret)
        with pytest.raises(TypeError):
            json.dumps({"key": secret})

    def test_no_se_compara_ni_se_usa_de_clave(self) -> None:
        a, b = Secret(KEY), Secret(KEY)
        assert a != b  # comparar secretos no es una operación que el código deba hacer
        with pytest.raises(TypeError):
            hash(a)

    def test_la_huella_identifica_sin_revelar(self) -> None:
        fingerprint = Secret(KEY).fingerprint()
        assert fingerprint == hashlib.sha256(KEY.encode()).hexdigest()[:12]
        assert KEY not in fingerprint

    def test_wipe_borra_el_valor(self) -> None:
        secret = Secret(KEY)
        secret.wipe()
        with pytest.raises(ValueError):
            secret.reveal()
        assert KEY not in repr(secret)

    def test_un_valor_vacio_o_no_texto_se_rechaza(self) -> None:
        for bad in ("", None, 7):
            with pytest.raises((TypeError, ValueError)):
                Secret(bad)  # type: ignore[arg-type]


class TestRedactor:
    def test_censura_el_valor_registrado_y_deja_lo_demas(self) -> None:
        REDACTOR.register(KEY)
        assert REDACTOR.redact(f"falló con {KEY} al llamar") == f"falló con {REDACTED} al llamar"
        assert REDACTOR.redact("sin secretos aquí") == "sin secretos aquí"

    def test_censura_las_formas_escapadas(self) -> None:
        odd = 'sk-raro"con/barra+y espacio\\final-1234567890abcdef'
        REDACTOR.register(odd)
        assert odd not in REDACTOR.redact(f"valor {odd}")
        assert odd not in REDACTOR.redact(f"json {json.dumps(odd)}")
        assert odd not in REDACTOR.redact(f"url {urllib.parse.quote(odd, safe='')}")
        assert odd not in REDACTOR.redact(f"repr {odd!r}")

    def test_censura_claves_con_forma_de_clave_aunque_no_esten_registradas(self) -> None:
        text = "Incorrect API key provided: sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789."
        assert "AbCdEfGh" not in REDACTOR.redact(text)
        assert "Bearer abcdefghijklmnopqrstuvwxyz0123456789" not in REDACTOR.redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789")

    def test_un_secreto_demasiado_corto_no_se_registra(self) -> None:
        with pytest.raises(ValueError):
            REDACTOR.register("corto")

    def test_unregister_deja_de_censurar(self) -> None:
        REDACTOR.register("otra-clave-sin-forma-12345678")
        assert REDACTOR.redact("otra-clave-sin-forma-12345678") == REDACTED
        REDACTOR.unregister("otra-clave-sin-forma-12345678")
        assert REDACTOR.redact("otra-clave-sin-forma-12345678") == "otra-clave-sin-forma-12345678"

    def test_varios_secretos_a_la_vez(self) -> None:
        REDACTOR.register("eleven-clave-uno-0123456789")
        REDACTOR.register("eleven-clave-dos-9876543210")
        text = REDACTOR.redact("a eleven-clave-uno-0123456789 y eleven-clave-dos-9876543210")
        assert "clave-uno" not in text and "clave-dos" not in text


class TestRedactingFilter:
    def test_censura_el_mensaje_y_los_argumentos(self) -> None:
        REDACTOR.register(KEY)
        record = _record("usando %s en el trabajo %s", KEY, "abc")
        assert RedactingFilter().filter(record) is True
        assert KEY not in record.getMessage()
        assert "trabajo abc" in record.getMessage()

    def test_censura_las_trazas(self) -> None:
        REDACTOR.register(KEY)
        try:
            raise RuntimeError(f"auth falló con {KEY}")
        except RuntimeError:
            import sys

            record = _record("fallo", exc_info=sys.exc_info())
        RedactingFilter().filter(record)
        assert record.exc_info is None
        assert record.exc_text is not None and KEY not in record.exc_text
        assert "RuntimeError" in record.exc_text  # la traza sigue siendo útil

    def test_el_formateador_json_conserva_la_traza_censurada(self) -> None:
        REDACTOR.register(KEY)
        try:
            raise RuntimeError(f"auth falló con {KEY}")
        except RuntimeError:
            import sys

            record = _record("fallo", exc_info=sys.exc_info())
        RedactingFilter().filter(record)
        line = JsonFormatter().format(record)
        assert KEY not in line
        assert "RuntimeError" in json.loads(line)["stack"]

    def test_un_registro_limpio_queda_igual(self) -> None:
        record = _record("hola %s", "mundo")
        RedactingFilter().filter(record)
        assert record.getMessage() == "hola mundo"

    def test_configure_logging_lo_instala_en_todos_los_manejadores_del_registro_raiz(self) -> None:
        configure_logging("json")
        handlers = logging.getLogger().handlers
        assert handlers
        for handler in handlers:
            assert any(isinstance(f, RedactingFilter) for f in handler.filters)

    def test_lo_que_registra_cualquier_biblioteca_sale_censurado(self) -> None:
        configure_logging("text")
        REDACTOR.register(KEY)
        stream = io.StringIO()
        handler = logging.getLogger().handlers[0]
        assert isinstance(handler, logging.StreamHandler)
        handler.setStream(stream)
        logging.getLogger("httpx").error("petición con %s", KEY)
        try:
            raise ValueError(f"detalle {KEY}")
        except ValueError:
            logging.getLogger("ai_worker").exception("falló")
        assert KEY not in stream.getvalue()
        assert REDACTED in stream.getvalue()


class TestJobFailure:
    def test_el_mensaje_para_el_usuario_nunca_lleva_la_clave(self) -> None:
        REDACTOR.register(KEY)
        failure = JobFailure("INTERNAL", f"El proveedor dijo: Incorrect API key provided: {KEY}")
        assert KEY not in failure.message
        assert KEY not in str(failure)
        assert REDACTED in failure.message
