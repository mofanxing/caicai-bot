"""Collect coherent phrases instead of synthesizing a tiny greeting on its own."""
import re


def speech_boundary(text: str, first: bool) -> int:
    minimum, maximum = (32 if first else 60), 120
    # Sentence boundaries preserve punctuation and do not split English decimals.
    for match in re.finditer(r"[。！？!?；;\n]+[”’\"']*|\.(?=\s|$)", text):
        if minimum <= match.end() <= maximum:
            return match.end()
    if len(text) < maximum:
        return 0
    # At the latency cap, prefer a clause boundary over an arbitrary character.
    soft = list(re.finditer(r"[，、,:：\s]", text[:maximum]))
    candidates = [match.end() for match in soft if match.end() >= minimum]
    return candidates[-1] if candidates else maximum
