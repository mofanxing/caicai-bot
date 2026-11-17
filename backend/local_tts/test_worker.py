"""Run with .tts-venv/bin/python -m unittest local_tts/test_worker.py. No GPU needed."""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import soundfile as sf

from local_tts.worker import match_speech_level, synthesize_request


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.rate = 48000
        self.wave = np.sin(np.arange(self.rate) * 2 * np.pi * 220 / self.rate)

    def test_level_matches_active_speech_without_amplifying_silence(self):
        quiet = match_speech_level(self.wave * 0.08, self.rate, np)
        loud = match_speech_level(self.wave * 0.4, self.rate, np)
        self.assertAlmostEqual(float(np.sqrt(np.mean(quiet ** 2))), 0.1, places=5)
        np.testing.assert_allclose(quiet, loud, atol=1e-6)
        padded = np.concatenate([np.zeros(self.rate), self.wave * 0.08])
        normalized = match_speech_level(padded, self.rate, np)
        np.testing.assert_allclose(normalized[self.rate:], quiet, atol=1e-6)
        self.assertTrue(np.all(normalized[:self.rate] == 0))
        np.testing.assert_array_equal(
            match_speech_level(np.zeros(50), self.rate, np), np.zeros(50),
        )

    def test_gain_is_bounded_and_output_cannot_clip(self):
        tiny = self.wave * 0.001
        adjusted = match_speech_level(tiny, self.rate, np)
        self.assertLessEqual(float(np.max(np.abs(adjusted))), 0.001 * 10 ** (6 / 20) + 1e-8)
        spike = np.full(self.rate, 0.01)
        spike[20] = 4
        adjusted = match_speech_level(spike, self.rate, np)
        self.assertLessEqual(float(np.max(np.abs(adjusted))), 10 ** (-1 / 20) + 1e-7)
        for data, rate in [([], self.rate), ([np.nan], self.rate), ([1], 0)]:
            with self.assertRaises(ValueError):
                match_speech_level(data, rate, np)

    def generate(self, text, continuation=None, rates=None):
        calls = []
        def generate(**options):
            calls.append(options)
            rate = rates[len(calls) - 1] if rates else self.rate
            yield SimpleNamespace(audio=self.wave * 0.2, sample_rate=rate, token_count=20)
        request = {
            "text": text, "reference_path": "original.wav",
            "style_prompt": "温柔自然", "output_path": str(self.root / "out.wav"),
        }
        if continuation:
            request["continuation"] = continuation
        duration = synthesize_request(
            SimpleNamespace(generate=generate), request,
            SimpleNamespace(random=SimpleNamespace(seed=lambda seed: None)), np, sf,
        )
        return calls, duration

    def test_chunks_share_first_anchor_without_duplicating_audio(self):
        sentence = "好" * 70 + "。"
        calls, duration = self.generate(sentence * 3)
        self.assertEqual(len(calls), 3)
        self.assertNotIn("prompt_audio", calls[0])
        self.assertIs(calls[1]["prompt_audio"], calls[2]["prompt_audio"])
        self.assertEqual(calls[1]["prompt_text"], sentence)
        self.assertTrue(all(call["ref_audio"] == "original.wav" for call in calls))
        self.assertTrue(all("instruct" not in call for call in calls))
        self.assertTrue(all(call["text"] == sentence for call in calls))
        self.assertEqual(duration, 3)
        saved, rate = sf.read(self.root / "out.wav")
        self.assertEqual((len(saved), rate), (self.rate * 3, self.rate))
        # New requests never inherit the preceding request's anchor.
        calls, _ = self.generate("另一次试听。")
        self.assertNotIn("prompt_audio", calls[0])

    def test_external_anchor_is_used_for_all_chunks(self):
        anchor = self.root / "anchor.wav"
        sf.write(anchor, self.wave * 0.2, self.rate)
        calls, _ = self.generate("好" * 70 + "。" + "对" * 70 + "。", {
            "text": "首段文字。", "audio_path": str(anchor),
        })
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call["prompt_audio"] == str(anchor) for call in calls))
        self.assertTrue(all(call["prompt_text"] == "首段文字。" for call in calls))
        self.assertTrue(all("instruct" not in call for call in calls))
        self.assertTrue(all("温柔自然" not in call["text"] for call in calls))

    def test_invalid_anchor_and_rate_changes_fail_before_output(self):
        anchor = self.root / "long.wav"
        sf.write(anchor, np.zeros(self.rate * 31), self.rate)
        with self.assertRaises(ValueError):
            self.generate("下一句。", {"text": "前一句。", "audio_path": str(anchor)})
        with self.assertRaises(ValueError):
            self.generate("好" * 70 + "。" + "对" * 70 + "。", rates=[48000, 24000])
        with self.assertRaises(ValueError):
            self.generate(" " )
        self.assertFalse((self.root / "out.wav").exists())


if __name__ == "__main__":
    unittest.main()
