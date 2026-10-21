"""Regenera packages/contracts/examples/segments-golden.json con las funciones de legacy/src/captionforge/srt.py.

Ejecutar desde la raíz del repositorio:  python packages/contracts/scripts/gen-segments-golden.py
"""

import json
import sys

sys.path.insert(0, "legacy/src")
from captionforge.srt import (  # noqa: E402
    Segment,
    redistribute_word_timings,
    segments_to_dicts,
    segments_to_srt,
    word_timing_to_dict,
)


def seg(start, end, text):
    return Segment(start=start, end=end, text=text, words=None)


SRT_CASES = {
    "basico": [seg(0.0, 1.5, " Hola mundo"), seg(1.5, 3.25, "Segunda línea\ncon salto ")],
    "redondeo_al_par": [seg(0.0005, 0.0015, "a"), seg(0.0025, 0.0035, "b"), seg(1.0005, 2.0015, "c")],
    "mas_de_una_hora": [seg(3661.0075, 7322.5, "larga")],
    "vacio": [],
    "unicode": [seg(0.0, 1.0, " ¿Qué tal? 👍🏽")],
}
REDISTRIBUTE_CASES = [
    ("hola mundo cruel", 0.0, 3.0),
    ("  uno   dos\ttres\ncuatro ", 10.0, 12.5),
    ("👍🏽 ok añadir", 1.0, 2.0),
    ("", 0.0, 1.0),
    ("   ", 0.0, 1.0),
    ("sola", 5.0, 5.0),
    ("una dos", 2.0, 1.0),
    ("a bb ccc dddd eeeee", 0.1, 7.3),
]


def words(timings):
    return None if timings is None else [word_timing_to_dict(w) for w in timings]


out = {
    "_comment": (
        "GENERADO por Python (legacy/src/captionforge/srt.py): la fuente de verdad. Lo verifican las pruebas "
        "de api-gateway y de ai-worker; regenerar con packages/contracts/scripts/gen-segments-golden.py "
        "si cambia srt.py."
    ),
    "srt": [{"name": k, "segments": segments_to_dicts(v), "expected": segments_to_srt(v)} for k, v in SRT_CASES.items()],
    "redistribute": [
        {"text": t, "start": a, "end": b, "expected": words(redistribute_word_timings(t, a, b))}
        for t, a, b in REDISTRIBUTE_CASES
    ],
}
with open("packages/contracts/examples/segments-golden.json", "w", encoding="utf-8", newline="\n") as handle:
    handle.write(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
print(len(out["srt"]), "casos SRT,", len(out["redistribute"]), "casos de reparto")
