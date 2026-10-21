from captionforge.languages import WHISPER_LANGUAGE_CODES, WHISPER_LANGUAGE_NAMES


def test_every_whisper_language_code_has_a_display_name():
    assert set(WHISPER_LANGUAGE_NAMES.keys()) == set(WHISPER_LANGUAGE_CODES)


def test_no_extra_names_for_codes_the_tokenizer_does_not_accept():
    # The reverse of the check above, spelled out separately so a future
    # edit that only adds a name (without removing a stale one after a
    # faster-whisper downgrade) still fails on the exact right assertion.
    assert set(WHISPER_LANGUAGE_NAMES.keys()) <= set(WHISPER_LANGUAGE_CODES)
