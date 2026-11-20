import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WAKE_WORD, extractWakeCommand, matchWakeCommand, MicrophoneCapture, normalizeWakeWord,
  readVoiceSettings, recordingBlob, UtteranceDetector, validWakeWord, VOICE_SETTINGS_KEY } from './voice-input';

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('wake words', () => {
  it('keeps defaults and recovers from damaged browser settings', () => {
    expect(readVoiceSettings()).toEqual({ wakeEnabled: true, wakeWord: DEFAULT_WAKE_WORD });
    localStorage.setItem(VOICE_SETTINGS_KEY, 'invalid-json');
    expect(readVoiceSettings().wakeWord).toBe(DEFAULT_WAKE_WORD);
    localStorage.setItem(VOICE_SETTINGS_KEY, 'null');
    expect(readVoiceSettings().wakeWord).toBe(DEFAULT_WAKE_WORD);
    localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify({ wakeEnabled: false, wakeWord: '小助手' }));
    expect(readVoiceSettings()).toEqual({ wakeEnabled: false, wakeWord: '小助手' });
  });

  it('ignores spacing, punctuation, fullwidth characters and English casing', () => {
    expect(normalizeWakeWord(' Ｈｅｙ，菜 菜！')).toBe('hey菜菜');
    expect(extractWakeCommand('菜，菜！提醒我在 3:00 喝水。', '菜菜')).toBe('提醒我在 3:00 喝水。');
    expect(extractWakeCommand('HEY CAICAI, Read README.md!', 'hey caicai')).toBe('Read README.md!');
    expect(extractWakeCommand('菜菜。', '菜菜')).toBe('');
    expect(extractWakeCommand('普通聊天内容', '菜菜')).toBeNull();
    expect(extractWakeCommand('你好', '')).toBeNull();
  });

  it('validates effective length rather than accepting punctuation-only words', () => {
    expect(validWakeWord('小助手')).toBe(true);
    expect(validWakeWord('Hey Caicai')).toBe(true);
    for (const value of ['', '  ', '，，', 'a', '菜'.repeat(25)]) expect(validWakeWord(value)).toBe(false);
  });

  it('recognizes Chinese homophones without changing the command transcript', async () => {
    expect(await matchWakeCommand('蔡蔡,告訴我現在幾點。', '菜菜')).toBe('告訴我現在幾點。');
    expect(await matchWakeCommand('采采，早上好。', '菜菜')).toBe('早上好。');
    expect(await matchWakeCommand('普通聊天内容', '菜菜')).toBeNull();
    expect(await matchWakeCommand('Hi Kay, hello', 'Hey Cai')).toBeNull();
  });
});

describe('utterance endpoint detection', () => {
  const frame = (volume: number, count = 1600) => new Float32Array(count).fill(volume);

  it('ignores silence and short clicks', () => {
    const detector = new UtteranceDetector(16000);
    for (let index = 0; index < 100; index++) expect(detector.push(frame(0))).toBeNull();
    detector.push(frame(0.1, 320));
    for (let index = 0; index < 10; index++) expect(detector.push(frame(0))).toBeNull();
    expect(detector.speaking).toBe(false);
  });

  it('keeps pre-roll and sends once after 900 ms silence', () => {
    const detector = new UtteranceDetector(16000);
    for (let index = 0; index < 10; index++) detector.push(frame(0));
    for (let index = 0; index < 5; index++) expect(detector.push(frame(0.1))).toBeNull();
    expect(detector.speaking).toBe(true);
    for (let index = 0; index < 8; index++) expect(detector.push(frame(0))).toBeNull();
    const utterance = detector.push(frame(0));
    expect(utterance?.length).toBe(1600 * 16);
    expect(utterance?.some(value => value > 0)).toBe(true);
    expect(detector.speaking).toBe(false);
    expect(detector.push(frame(0))).toBeNull();
  });

  it('does not split on a brief pause and discards unfinished speech when paused', () => {
    const detector = new UtteranceDetector(16000);
    detector.push(frame(0.1, 8000));
    expect(detector.push(frame(0, 8000))).toBeNull();
    expect(detector.push(frame(0.1, 8000))).toBeNull();
    detector.reset();
    expect(detector.push(frame(0, 16000))).toBeNull();
    expect(detector.speaking).toBe(false);
  });

  it('caps each recording at 20 seconds and waits for silence before another', () => {
    const detector = new UtteranceDetector(16000);
    const utterance = detector.push(frame(0.1, 16000 * 21));
    expect(utterance?.length).toBe(320000);
    expect(detector.push(frame(0.1, 16000))).toBeNull();
    expect(detector.push(frame(0, 16000))).toBeNull();
    expect(detector.push(frame(0.1, 8000))).toBeNull();
    expect(detector.push(frame(0, 16000))?.length).toBe(24000);
  });

  it('resamples recordings to bounded PCM16 mono WAV without persisting files', async () => {
    const blob = recordingBlob(frame(0.25, 48000), 48000);
    const buffer = await new Promise<ArrayBuffer>(resolve => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.readAsArrayBuffer(blob);
    });
    const data = new DataView(buffer);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 16000 * 2);
    expect(data.getUint32(24, true)).toBe(16000);
    expect(data.getUint16(22, true)).toBe(1);
    expect(data.getUint16(34, true)).toBe(16);
    expect(data.getInt16(44, true)).toBe(8191);
    expect(recordingBlob(frame(0.1, 48000 * 21), 48000).size).toBe(44 + 320000 * 2);
  });
});

describe('microphone resource lifecycle', () => {
  it('releases a late microphone grant after the user has stopped', async () => {
    let grant!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => { grant = resolve; }));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    vi.stubGlobal('AudioWorkletNode', class {});
    const capture = new MicrophoneCapture(vi.fn(), vi.fn(), vi.fn());
    const starting = capture.start();
    capture.stop();
    const stop = vi.fn();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await starting;
    expect(stop).toHaveBeenCalledOnce();
  });

  it('explains unsupported capture environments before accessing the microphone', async () => {
    vi.stubGlobal('AudioWorkletNode', undefined);
    const capture = new MicrophoneCapture(vi.fn(), vi.fn(), vi.fn());
    await expect(capture.start()).rejects.toThrow(/无法录音/);
  });
});
