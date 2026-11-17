from app.services.speech_text import speech_boundary


def test_short_greeting_waits_for_a_complete_following_sentence():
    assert speech_boundary("你好呀。", first=True) == 0
    text = "你好呀。" + "我们可以先把这件事情说清楚，再一起慢慢讨论你提到的那些具体问题。"
    assert speech_boundary(text, first=True) == len(text)


def test_following_chunks_merge_short_sentences():
    assert speech_boundary("这是第二句。" * 5, first=False) == 0
    text = "这是第二句。" * 12
    cut = speech_boundary(text, first=False)
    assert 60 <= cut <= 120 and text[cut - 1] == "。"


def test_long_sentence_prefers_a_clause_boundary():
    text = "好" * 70 + "，" + "好" * 100
    assert speech_boundary(text, first=True) == 71
    assert speech_boundary("a" * 130, first=True) == 120


def test_decimal_is_not_a_sentence_boundary():
    assert speech_boundary("a" * 32 + "3.14", first=True) == 0
