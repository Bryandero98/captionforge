"""Compilador de subtítulos dinámicos ASS (Issue #13, parte 2).

Módulo PURO: sin ffmpeg, sin red, sin E/S. Recibe segmentos con tiempos por palabra (los mismos de `GET /segments`/`segments.json`) y devuelve el
texto de un archivo `.ass` paginado en pantallas de pocas palabras, con resalte palabra por palabra:

    segmentos -> words_of (tiempos reales, o alineados/proporcionales y marcados `approximate`)
              -> paginate (pantallas de N palabras)
              -> render_ass (plantilla + lienzo -> .ass)

Seguridad: el texto del usuario NUNCA llega crudo al ASS (`escape_ass_text`): ni llaves (bloques de override), ni barras invertidas (`\\N`,
`\\h`...), ni saltos de línea (que crearían líneas de evento nuevas). Las únicas etiquetas del archivo son las que escribe este módulo.
La plantilla se elige por nombre en una lista cerrada (`get_template`), nunca por ruta.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass

from captionforge.srt import Segment, format_ass_timestamp

#: Duración mínima de una pantalla (s). Una pantalla más corta no se alcanza a leer; se alarga hasta el hueco libre que haya.
MIN_PAGE_SECONDS = 0.35
_SENTENCE_END = re.compile(r"[.!?;:…]$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f  ]+")


# ---------- plantillas ----------


@dataclass(frozen=True)
class Template:
    id: str
    font: str  # familia que fontconfig resuelve en la imagen (ver apps/ai-worker/fonts)
    mode: str  # "sweep" (barrido \kf) | "pop" (palabra activa crece) | "color" (palabra activa cambia de color)
    max_words: int  # palabras por pantalla (1 a 4)
    size_ratio: float  # tamaño de letra relativo a la altura del lienzo
    margin_ratio: float  # margen inferior relativo a la altura del lienzo
    primary: str  # color de la palabra ya dicha/activa (ASS: &HAABBGGRR)
    secondary: str  # color de la palabra todavía no dicha
    outline_colour: str
    back_colour: str
    outline: float  # grosor del contorno relativo a la altura del lienzo * 1000 (milésimas)
    shadow: float
    upper: bool = False
    pop_scale: int = 118  # % que crece la palabra activa en `pop`


TEMPLATES: dict[str, Template] = {
    # Pesada, mayúsculas, la palabra activa salta y se asienta: el estilo "Shorts/Reels".
    "bold-pop": Template("bold-pop", "Montserrat ExtraBold", "pop", 3, 0.052, 0.20, "&H0000E5FF", "&H00FFFFFF", "&H00000000", "&H80000000", 4.0, 0.0, upper=True, pop_scale=120),
    # Redondeada, barrido de color de izquierda a derecha por palabra.
    "rounded-sweep": Template("rounded-sweep", "Nunito ExtraBold", "sweep", 4, 0.046, 0.20, "&H0000E5FF", "&H00FFFFFF", "&H00302010", "&H80000000", 3.5, 1.0),
    # Sobria: la palabra activa solo cambia de color.
    "clean-color": Template("clean-color", "Nunito ExtraBold", "color", 4, 0.042, 0.20, "&H0000C8FF", "&H00FFFFFF", "&H00000000", "&H64000000", 3.0, 0.0),
}


def get_template(name: str) -> Template:
    """Plantilla por nombre en la lista cerrada; cualquier otra cosa (una ruta, un nombre inventado) es KeyError."""
    return TEMPLATES[name]


# ---------- texto ----------


def escape_ass_text(text: str) -> str:
    """Hace inofensivo el texto de un subtítulo para el campo Text de un evento ASS.

    - `{` y `}` abren y cierran bloques de override (cualquier `\\tag`): se cambian por sus formas de ancho completo.
    - `\\` inicia `\\N`, `\\h`, `\\an8`...: se cambia por `＼` (ancho completo).
    - Saltos de línea y caracteres de control (que crearían líneas de evento nuevas o romperían el archivo) pasan a un espacio.
    """
    cleaned = _CONTROL.sub(" ", text)
    return cleaned.replace("\\", "＼").replace("{", "｛").replace("}", "｝")


# ---------- palabras ----------


@dataclass(frozen=True)
class PageWord:
    text: str
    start: float
    end: float


@dataclass(frozen=True)
class Page:
    start: float
    end: float
    words: tuple[PageWord, ...]
    approximate: bool = False


def normalize_words(segment: Segment) -> list[PageWord] | None:
    """Palabras del segmento ordenadas, recortadas a [inicio, fin] del segmento y sin solapes; None si no queda un conjunto utilizable."""
    if not segment.words:
        return None
    ordered = sorted(segment.words, key=lambda word: (word.start, word.end))
    out: list[PageWord] = []
    cursor = segment.start
    for word in ordered:
        text = word.text.strip()
        if not text:
            continue
        start = max(word.start, cursor, segment.start)
        end = min(word.end, segment.end)
        if end <= start:
            continue  # fuera del segmento o aplastada por la anterior
        out.append(PageWord(text, start, end))
        cursor = end
    return out or None


def _tokens(text: str) -> list[str]:
    return text.split()


def _spread(tokens: list[str], start: float, end: float) -> list[PageWord]:
    """Reparte [start, end] entre las palabras en proporción a su largo (más una unidad por palabra)."""
    if not tokens:
        return []
    span = max(end - start, 0.0)
    weights = [len(token) + 1 for token in tokens]
    total = sum(weights)
    out: list[PageWord] = []
    cursor = start
    for index, (token, weight) in enumerate(zip(tokens, weights, strict=True)):
        stop = end if index == len(tokens) - 1 else cursor + span * weight / total
        out.append(PageWord(token, cursor, stop))
        cursor = stop
    return out


def words_of(segment: Segment) -> tuple[list[PageWord], bool]:
    """(palabras con tiempo, ¿aproximado?). Exacto solo si las palabras guardadas coinciden con el texto actual."""
    tokens = _tokens(segment.text)
    if not tokens:
        return [], False
    known = normalize_words(segment)
    if known is not None and [w.text for w in known] == tokens:
        return known, False
    if known is None:
        return _spread(tokens, segment.start, segment.end), True

    # El texto cambió: se alinean las palabras con las originales; las que coinciden conservan su tiempo.
    matcher = difflib.SequenceMatcher(a=[w.text.lower() for w in known], b=[t.lower() for t in tokens], autojunk=False)
    placed: list[PageWord | None] = [None] * len(tokens)
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            original = known[block.a + offset]
            placed[block.b + offset] = PageWord(tokens[block.b + offset], original.start, original.end)
    out: list[PageWord] = []
    index = 0
    while index < len(tokens):
        if placed[index] is not None:
            out.append(placed[index])  # type: ignore[arg-type]
            index += 1
            continue
        run_end = index
        while run_end < len(tokens) and placed[run_end] is None:
            run_end += 1
        left = out[-1].end if out else segment.start
        right = placed[run_end].start if run_end < len(tokens) else segment.end  # type: ignore[union-attr]
        out.extend(_spread(tokens[index:run_end], left, max(right, left)))
        index = run_end
    return out, True


# ---------- paginación ----------


def paginate(segments: list[Segment], max_words: int) -> list[Page]:
    """Pantallas de hasta `max_words` palabras, con los tiempos de sus palabras, en orden y sin solaparse."""
    if not 1 <= max_words <= 4:
        raise ValueError("max_words debe estar entre 1 y 4")
    pages: list[Page] = []
    for segment in sorted(segments, key=lambda s: (s.start, s.end)):
        words, approximate = words_of(segment)
        chunk: list[PageWord] = []
        for word in words:
            chunk.append(word)
            # Corta al llegar al tope o tras puntuación de fin de frase: una frase nueva no arrastra palabras de la anterior.
            if len(chunk) == max_words or _SENTENCE_END.search(word.text):
                pages.append(Page(chunk[0].start, chunk[-1].end, tuple(chunk), approximate))
                chunk = []
        if chunk:
            pages.append(Page(chunk[0].start, chunk[-1].end, tuple(chunk), approximate))
    return _fit_durations(pages)


def _fit_durations(pages: list[Page]) -> list[Page]:
    """Alarga las pantallas muy cortas hasta MIN_PAGE_SECONDS sin pisar a la siguiente, y recorta solapes."""
    out: list[Page] = []
    for index, page in enumerate(pages):
        end = page.end
        limit = pages[index + 1].start if index + 1 < len(pages) else float("inf")
        if end - page.start < MIN_PAGE_SECONDS:
            end = min(page.start + MIN_PAGE_SECONDS, limit)
        end = min(end, limit) if limit > page.start else end
        if end <= page.start:
            end = page.start + 0.01
        out.append(Page(page.start, end, page.words, page.approximate))
    return out


# ---------- ASS ----------


def _cs(seconds: float) -> int:
    return max(round(seconds * 100), 0)


def _display(template: Template, text: str) -> str:
    return escape_ass_text(text.upper() if template.upper else text)


def _header(template: Template, canvas: tuple[int, int]) -> str:
    width, height = canvas
    size = round(template.size_ratio * height)
    margin = round(template.margin_ratio * height)
    side = round(0.05 * width)
    outline = round(template.outline * height / 1000, 1)
    # En `sweep` el color primario es el de la palabra ya cantada (\kf pinta de secundario a primario); en `pop` y `color` el texto base es el
    # secundario y la palabra activa se pinta de primario con c.
    base, lit = (template.primary, template.secondary) if template.mode == "sweep" else (template.secondary, template.primary)
    style = (
        f"Style: Default,{template.font},{size},{base},{lit},{template.outline_colour},{template.back_colour},"
        f"-1,0,0,0,100,100,0,0,1,{outline},{template.shadow},2,{side},{side},{margin},1"
    )
    return (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n"
        "WrapStyle: 2\n"
        "ScaledBorderAndShadow: yes\n"
        "\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"{style}\n"
        "\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )


def _event(start: float, end: float, text: str) -> str:
    return f"Dialogue: 0,{format_ass_timestamp(start)},{format_ass_timestamp(end)},Default,,0,0,0,,{text}"


def _sweep(page: Page, template: Template) -> list[str]:
    parts: list[str] = []
    gap = _cs(page.words[0].start - page.start)
    if gap:
        parts.append(f"{{\\k{gap}}}")
    for index, word in enumerate(page.words):
        following = page.words[index + 1].start if index + 1 < len(page.words) else page.end
        space = " " if index + 1 < len(page.words) else ""
        parts.append(f"{{\\kf{_cs(following - word.start)}}}{_display(template, word.text)}{space}")
    return [_event(page.start, page.end, "".join(parts))]


def _active(page: Page, template: Template, active: int) -> str:
    pieces: list[str] = []
    for index, word in enumerate(page.words):
        text = _display(template, word.text)
        if index == active:
            if template.mode == "pop":
                grow = template.pop_scale
                pieces.append(f"{{\\1c{template.primary}&\\fscx{grow}\\fscy{grow}\\t(0,90,\\fscx100\\fscy100)}}{text}{{\\r}}")
            else:
                pieces.append(f"{{\\1c{template.primary}&}}{text}{{\\r}}")
        else:
            pieces.append(text)
    return " ".join(pieces)


def _per_word(page: Page, template: Template) -> list[str]:
    events: list[str] = []
    for index, word in enumerate(page.words):
        start = page.start if index == 0 else word.start
        end = page.end if index + 1 == len(page.words) else page.words[index + 1].start
        events.append(_event(start, max(end, start), _active(page, template, index)))
    return events


def render_ass(pages: list[Page], template: Template, canvas: tuple[int, int]) -> str:
    """Archivo .ass completo. `canvas` = (ancho, alto) del video de salida: el tamaño de letra y los márgenes salen de ahí."""
    events: list[str] = []
    for page in pages:
        events.extend(_sweep(page, template) if template.mode == "sweep" else _per_word(page, template))
    return _header(template, canvas) + "\n".join(events) + ("\n" if events else "")
