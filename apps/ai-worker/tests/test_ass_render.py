"""Compilador ASS (Issue #13, parte 2): segmentos con tiempos por palabra -> pantallas de pocas palabras -> .ass con resalte `sweep` o `pop`.
Módulo puro: sin ffmpeg, sin red, sin base de datos."""

from __future__ import annotations

import re

import pytest
from captionforge.srt import Segment, WordTiming

from ai_worker.ass_render import (
    TEMPLATES,
    Page,
    escape_ass_text,
    normalize_words,
    paginate,
    render_ass,
    words_of,
)


def seg(start: float, end: float, text: str, words: list[tuple[str, float, float]] | None = None) -> Segment:
    timings = [WordTiming(start=s, end=e, text=f" {w}") for w, s, e in words] if words else None
    return Segment(start=start, end=end, text=f" {text}", words=timings)


HELLO = seg(0.0, 2.0, "Hola mundo cruel de verdad", [("Hola", 0.0, 0.4), ("mundo", 0.5, 1.0), ("cruel", 1.0, 1.4), ("de", 1.5, 1.6), ("verdad", 1.6, 2.0)])


def texts(page: Page) -> list[str]:
    return [word.text for word in page.words]


# ---------- escape ----------


@pytest.mark.parametrize(
    "hostile",
    [
        "{\\an8}arriba",
        "{\\fs500}enorme{\\r}",
        "a\\Nb",
        "a\\nb",
        "linea1\nDialogue: 0,0:00:00.00,9:00:00.00,Default,,0,0,0,,inyectado",
        "a\r\nb",
        "tab\tcon\x00nulo\x1b",
        "\\{\\}",
        "}{",
    ],
)
def test_escape_leaves_no_override_blocks_line_breaks_or_backslashes(hostile) -> None:  # noqa: ANN001
    escaped = escape_ass_text(hostile)
    assert "{" not in escaped and "}" not in escaped and "\\" not in escaped
    assert "\n" not in escaped and "\r" not in escaped and "\x00" not in escaped and "\x1b" not in escaped


def test_escape_keeps_normal_text_untouched() -> None:
    assert escape_ass_text("¿Cómo estás? ¡Bien! 100 % ñandú — “ok”") == "¿Cómo estás? ¡Bien! 100 % ñandú — “ok”"


def test_hostile_text_never_reaches_the_ass_as_tags_or_new_events() -> None:
    hostile = seg(0, 2, "{\\an8}hola\nDialogue: 0,0:00:00.00,9:00:00.00,Default,,0,0,0,,x \\N fin", [("{\\an8}hola", 0, 1), ("Dialogue:", 1, 2)])
    for template in TEMPLATES.values():
        ass = render_ass(paginate([hostile], template.max_words), template, (1080, 1920))
        events = [line for line in ass.split("\n") if line.startswith("Dialogue:")]
        assert events and all(line.count(",") >= 9 for line in events)
        body = "\n".join(event.split(",", 9)[9] for event in events)
        # Las únicas etiquetas del cuerpo son las que escribe el compilador.
        assert set(re.findall(r"\\([A-Za-z]+)", body)) <= {"kf", "k", "fscx", "fscy", "t", "c", "r"}
        assert not re.search(r"\\N", body)
        assert ass.count("\nDialogue:") == len(events)  # la carga no creó un evento más


# ---------- normalización de palabras ----------


def test_words_are_clipped_to_the_segment_and_never_overlap() -> None:
    messy = seg(1.0, 3.0, "uno dos tres", [("uno", 0.5, 1.6), ("dos", 1.4, 2.2), ("tres", 2.2, 3.9)])
    words = normalize_words(messy)
    assert [w.text.strip() for w in words] == ["uno", "dos", "tres"]
    assert words[0].start >= 1.0 and words[-1].end <= 3.0
    assert all(a.end <= b.start + 1e-9 for a, b in zip(words, words[1:], strict=False))
    assert all(w.end >= w.start for w in words)


def test_unusable_words_are_dropped() -> None:
    assert normalize_words(seg(0, 2, "a b", [("a", 5.0, 6.0), ("b", 6.0, 7.0)])) is None  # todo fuera del segmento
    assert normalize_words(seg(0, 2, "a")) is None


# ---------- tiempos de cada palabra ----------


def test_exact_words_keep_their_real_times_and_are_not_approximate() -> None:
    words, approximate = words_of(HELLO)
    assert approximate is False
    assert [(w.text, w.start, w.end) for w in words] == [("Hola", 0.0, 0.4), ("mundo", 0.5, 1.0), ("cruel", 1.0, 1.4), ("de", 1.5, 1.6), ("verdad", 1.6, 2.0)]


def test_text_without_words_is_spread_proportionally_and_marked_approximate() -> None:
    words, approximate = words_of(seg(0.0, 4.0, "a bbb cc"))
    assert approximate is True
    assert [w.text for w in words] == ["a", "bbb", "cc"]
    assert words[0].start == 0.0 and words[-1].end == pytest.approx(4.0)
    durations = [w.end - w.start for w in words]
    assert durations[1] > durations[2] > durations[0]
    assert all(a.end <= b.start + 1e-9 for a, b in zip(words, words[1:], strict=False))


def test_edited_text_is_aligned_with_difflib_and_matching_words_keep_their_time() -> None:
    edited = Segment(start=0.0, end=2.0, text=" Hola mundo muy cruel de verdad", words=HELLO.words)
    words, approximate = words_of(edited)
    assert approximate is True
    by_text = {w.text: w for w in words}
    assert [w.text for w in words] == ["Hola", "mundo", "muy", "cruel", "de", "verdad"]
    for kept in ("Hola", "cruel", "verdad"):  # coinciden: conservan su tiempo original
        original = next(w for w in HELLO.words if w.text.strip() == kept)
        assert (by_text[kept].start, by_text[kept].end) == (original.start, original.end)
    # La palabra nueva cabe entre sus vecinas.
    assert by_text["mundo"].end <= by_text["muy"].start + 1e-9 <= by_text["cruel"].start + 1e-9


# ---------- paginación ----------


def test_pages_have_at_most_n_words_and_keep_all_the_text_in_order() -> None:
    for n in (1, 2, 3, 4):
        pages = paginate([HELLO], n)
        assert all(1 <= len(page.words) <= n for page in pages)
        assert [w for page in pages for w in texts(page)] == ["Hola", "mundo", "cruel", "de", "verdad"]


def test_pages_are_ordered_do_not_overlap_and_have_a_minimum_duration() -> None:
    quick = seg(0.0, 1.0, "uno dos tres cuatro cinco seis", [(w, i * 0.1, i * 0.1 + 0.1) for i, w in enumerate("uno dos tres cuatro cinco seis".split())])
    pages = paginate([quick, seg(1.0, 3.0, "siguiente frase aquí")], 2)
    assert [p.start for p in pages] == sorted(p.start for p in pages)
    assert all(a.end <= b.start + 1e-9 for a, b in zip(pages, pages[1:], strict=False))
    assert all(p.end - p.start >= 0.2 for p in pages[:-1])
    assert all(p.start < p.end for p in pages)


def test_pages_break_after_sentence_punctuation() -> None:
    pages = paginate([seg(0, 3, "Hola. Qué tal estás hoy", [("Hola.", 0, 0.5), ("Qué", 0.5, 1), ("tal", 1, 1.5), ("estás", 1.5, 2), ("hoy", 2, 3)])], 4)
    assert texts(pages[0]) == ["Hola."]
    assert [w for page in pages for w in texts(page)] == ["Hola.", "Qué", "tal", "estás", "hoy"]


def test_approximate_flag_travels_to_the_page() -> None:
    assert all(not page.approximate for page in paginate([HELLO], 3))
    assert all(page.approximate for page in paginate([seg(0, 2, "sin tiempos de palabra")], 3))


def test_empty_and_blank_segments_produce_no_pages() -> None:
    assert paginate([], 3) == []
    assert paginate([seg(0, 1, "   ")], 3) == []


# ---------- ASS ----------


def event_lines(ass: str) -> list[str]:
    return [line for line in ass.split("\n") if line.startswith("Dialogue:")]


def test_header_uses_the_canvas_and_the_template_font() -> None:
    for name, template in TEMPLATES.items():
        ass = render_ass(paginate([HELLO], template.max_words), template, (1080, 1920))
        assert "PlayResX: 1080" in ass and "PlayResY: 1920" in ass, name
        assert f"Style: Default,{template.font}," in ass, name
        assert "[Script Info]" in ass and "[V4+ Styles]" in ass and "[Events]" in ass


def test_font_size_and_margin_scale_with_the_canvas_height() -> None:
    template = TEMPLATES["bold-pop"]
    vertical = render_ass(paginate([HELLO], 2), template, (1080, 1920))
    landscape = render_ass(paginate([HELLO], 2), template, (1920, 1080))
    size = lambda ass: int(re.search(r"Style: Default,[^,]+,(\d+),", ass).group(1))  # noqa: E731
    assert size(vertical) > size(landscape)


def test_sweep_makes_one_event_per_page_with_kf_per_word() -> None:
    template = TEMPLATES["rounded-sweep"]
    assert template.mode == "sweep"
    pages = paginate([HELLO], template.max_words)
    events = event_lines(render_ass(pages, template, (1080, 1920)))
    assert len(events) == len(pages)
    first = events[0].split(",", 9)[9]
    assert first.count("\\kf") == len(pages[0].words)
    # La duración total de los \kf de la página cubre el tiempo de sus palabras (centésimas).
    total = sum(int(n) for n in re.findall(r"\\kf(\d+)", first))
    assert total == pytest.approx(round((pages[0].end - pages[0].start) * 100), abs=len(pages[0].words) + 2)


def test_pop_makes_one_event_per_word_and_scales_only_the_active_word() -> None:
    template = TEMPLATES["bold-pop"]
    assert template.mode == "pop"
    pages = paginate([HELLO], template.max_words)
    events = event_lines(render_ass(pages, template, (1080, 1920)))
    assert len(events) == sum(len(page.words) for page in pages)
    body = events[0].split(",", 9)[9]
    assert body.count("\\fscx") >= 1 and body.count("\\t(") == 1
    # En cada evento la pantalla completa se ve (todas sus palabras aparecen en el texto).
    first_page_words = texts(pages[0])
    plain = re.sub(r"\{[^}]*\}", "", body)
    assert plain.split() == [word.upper() for word in first_page_words]


def test_pop_events_of_a_page_are_contiguous_and_cover_it() -> None:
    template = TEMPLATES["bold-pop"]
    pages = paginate([HELLO], template.max_words)
    events = event_lines(render_ass(pages, template, (1080, 1920)))
    stamps = [(event.split(",", 3)[1], event.split(",", 3)[2]) for event in events[: len(pages[0].words)]]
    assert all(stamps[i][1] == stamps[i + 1][0] for i in range(len(stamps) - 1))


def test_color_mode_changes_the_colour_without_scaling() -> None:
    template = TEMPLATES["clean-color"]
    assert template.mode == "color"
    events = event_lines(render_ass(paginate([HELLO], template.max_words), template, (1080, 1920)))
    assert all("\\fscx" not in event and "\\t(" not in event for event in events)
    assert any("\\1c&H" in event for event in events)


def test_uppercase_templates_uppercase_the_text() -> None:
    template = TEMPLATES["bold-pop"]
    if template.upper:
        events = event_lines(render_ass(paginate([HELLO], template.max_words), template, (1080, 1920)))
        assert "HOLA" in events[0]


def test_timestamps_are_valid_ass_and_never_negative_or_inverted() -> None:
    for template in TEMPLATES.values():
        for event in event_lines(render_ass(paginate([HELLO, seg(2.0, 3.0, "otra cosa")], template.max_words), template, (1080, 1920))):
            _, start, end, *_ = event.split(",", 3) + [""]
            assert re.fullmatch(r"\d:\d\d:\d\d\.\d\d", start) and re.fullmatch(r"\d:\d\d:\d\d\.\d\d", end)
            assert end >= start


def test_templates_only_name_the_two_bundled_fonts_and_are_valid() -> None:
    assert {t.font for t in TEMPLATES.values()} <= {"Montserrat ExtraBold", "Nunito ExtraBold"}
    for template in TEMPLATES.values():
        assert 1 <= template.max_words <= 4
        assert re.fullmatch(r"&H[0-9A-F]{8}", template.primary) and re.fullmatch(r"&H[0-9A-F]{8}", template.secondary)
        assert template.mode in {"sweep", "pop", "color"}


def test_unknown_template_is_rejected_by_name() -> None:
    from ai_worker.ass_render import get_template

    with pytest.raises(KeyError):
        get_template("../../etc/passwd")
    assert get_template("bold-pop") is TEMPLATES["bold-pop"]
