from captionforge.ffmpeg_utils import (
    MODERN_SUBTITLE_STYLE,
    build_burn_subtitles_cmd,
    build_extract_audio_cmd,
)


class TestBuildExtractAudioCmd:
    def test_exact_argv(self):
        cmd = build_extract_audio_cmd("input.mp4", "output.wav")
        assert cmd == [
            "ffmpeg",
            "-y",
            "-i",
            "input.mp4",
            "-vn",
            "-acodec",
            "pcm_s16le",
            "-ar",
            "16000",
            "-ac",
            "1",
            "output.wav",
        ]

    def test_never_touches_subprocess(self):
        # A pure function returning a list - importing/calling it must not
        # require ffmpeg to actually be installed.
        result = build_extract_audio_cmd("a.mp4", "b.wav")
        assert isinstance(result, list)
        assert all(isinstance(part, str) for part in result)


class TestBuildBurnSubtitlesCmd:
    def test_basic_shape(self):
        cmd = build_burn_subtitles_cmd("input.mp4", "captions.srt", "output.mp4")
        assert cmd[0] == "ffmpeg"
        assert "-i" in cmd
        assert cmd[cmd.index("-i") + 1] == "input.mp4"
        assert cmd[-1] == "output.mp4"
        assert "-vf" in cmd

    def test_vf_argument_includes_modern_style(self):
        cmd = build_burn_subtitles_cmd("input.mp4", "captions.srt", "output.mp4")
        vf_value = cmd[cmd.index("-vf") + 1]
        assert MODERN_SUBTITLE_STYLE in vf_value
        assert "force_style=" in vf_value

    def test_windows_path_colon_and_backslash_are_escaped(self):
        # The subtitles filter's own mini-syntax treats ':' as an option
        # separator and '\' as its escape char - a raw Windows path like
        # this would otherwise corrupt the filter graph.
        windows_srt_path = r"C:\Users\test\captions.srt"
        cmd = build_burn_subtitles_cmd("input.mp4", windows_srt_path, "output.mp4")
        vf_value = cmd[cmd.index("-vf") + 1]

        # The raw, unescaped path must never appear verbatim in the filter.
        assert windows_srt_path not in vf_value
        # The drive-letter colon must be escaped.
        assert "C\\:" in vf_value
        # Every backslash in the original path must be doubled.
        assert "\\\\Users\\\\test\\\\captions.srt" in vf_value

    def test_single_quote_in_path_is_escaped(self):
        cmd = build_burn_subtitles_cmd("input.mp4", "it's.srt", "output.mp4")
        vf_value = cmd[cmd.index("-vf") + 1]
        assert "it\\'s.srt" in vf_value
