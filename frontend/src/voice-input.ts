import { encodeWav } from './audio';

export const DEFAULT_WAKE_WORD = '菜菜';
export const VOICE_SETTINGS_KEY = 'caicai.voice-input';
export type VoiceInputSettings = { wakeEnabled: boolean; wakeWord: string };

export function normalizeWakeWord(text: string) {
  return text.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
}

export function validWakeWord(text: string) {
  const length = normalizeWakeWord(text).length;
  return text.trim().length <= 32 && length >= 2 && length <= 24;
}

export function readVoiceSettings(): VoiceInputSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(VOICE_SETTINGS_KEY) || '{}');
    return { wakeEnabled: saved.wakeEnabled !== false,
      wakeWord: typeof saved.wakeWord === 'string' && validWakeWord(saved.wakeWord)
        ? saved.wakeWord.trim() : DEFAULT_WAKE_WORD };
  } catch { return { wakeEnabled: true, wakeWord: DEFAULT_WAKE_WORD }; }
}

// Preserve the original command's punctuation and casing after matching the wake word.
export function extractWakeCommand(text: string, wakeWord: string): string | null {
  const word = normalizeWakeWord(wakeWord);
  if (!word) return null;
  let normalized = ''; let offset = 0;
  const ends: number[] = [];
  for (const char of text) {
    offset += char.length;
    const part = normalizeWakeWord(char);
    normalized += part;
    for (let index = 0; index < part.length; index++) ends.push(offset);
  }
  const start = normalized.indexOf(word);
  if (start < 0) return null;
  return text.slice(ends[start + word.length - 1]).replace(/^[\p{P}\p{S}\s]+/u, '').trim();
}

export async function matchWakeCommand(text: string, wakeWord: string): Promise<string | null> {
  const exact = extractWakeCommand(text, wakeWord);
  if (exact !== null) return exact;
  const word = normalizeWakeWord(wakeWord);
  if (!/^[\p{Script=Han}]{2,24}$/u.test(word)) return null;
  // ASR commonly writes 菜菜 as 蔡蔡/采采. Load phonetics only when needed,
  // and require the same number of complete Chinese syllables.
  const { pinyin } = await import('pinyin-pro');
  const sound = pinyin(word, { toneType: 'none' });
  const chars = [...text];
  const normalized: { value: string; end: number }[] = [];
  let end = 0;
  for (const char of chars) {
    end += char.length;
    for (const value of normalizeWakeWord(char)) normalized.push({ value, end });
  }
  const size = [...word].length;
  for (let index = 0; index <= normalized.length - size; index++) {
    const candidate = normalized.slice(index, index + size).map(char => char.value).join('');
    if (!/^[\p{Script=Han}]+$/u.test(candidate) || pinyin(candidate, { toneType: 'none' }) !== sound) continue;
    return text.slice(normalized[index + size - 1].end).replace(/^[\p{P}\p{S}\s]+/u, '').trim();
  }
  return null;
}

export function recordingBlob(samples: Float32Array, sampleRate: number): Blob {
  if (sampleRate <= 0) throw new Error('麦克风采样率无效');
  const count = Math.min(20 * 16000, Math.floor(samples.length * 16000 / sampleRate));
  const resampled = new Float32Array(count);
  const ratio = sampleRate / 16000;
  for (let index = 0; index < count; index++) {
    const start = Math.floor(index * ratio);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
    let total = 0;
    for (let position = start; position < end; position++) total += samples[position];
    resampled[index] = total / (end - start);
  }
  return new Blob([encodeWav(resampled)], { type: 'audio/wav' });
}

// Sample-based endpoint detection: 250 ms pre-roll, 900 ms silence, 20 s hard limit.
export class UtteranceDetector {
  private preRoll: Float32Array[] = [];
  private frames: Float32Array[] = [];
  private length = 0;
  private voiced = 0;
  private silence = 0;
  private noise = 0.002;
  private clipped = false;
  speaking = false;

  constructor(private sampleRate: number) {}

  reset() {
    this.preRoll = []; this.frames = []; this.length = 0; this.voiced = 0;
    this.silence = 0; this.speaking = false; this.clipped = false;
  }

  push(frame: Float32Array): Float32Array | null {
    if (!frame.length) return null;
    let energy = 0;
    for (const value of frame) energy += value * value;
    const rms = Math.sqrt(energy / frame.length);
    const voice = rms >= Math.max(0.012, this.noise * 3);
    if (this.clipped) {
      this.silence = voice ? 0 : this.silence + frame.length;
      if (this.silence >= this.sampleRate * 0.9) this.reset();
      return null;
    }
    if (!this.speaking && !voice) {
      this.noise = Math.min(0.015, this.noise * 0.97 + rms * 0.03);
      this.preRoll.push(frame);
      while (this.preRoll.length > 1 && this.preRoll.reduce((sum, item) => sum + item.length, 0)
        > this.sampleRate * 0.25) this.preRoll.shift();
      return null;
    }
    if (!this.speaking) {
      this.speaking = true; this.frames = this.preRoll; this.preRoll = [];
      this.length = this.frames.reduce((sum, item) => sum + item.length, 0);
    }
    this.frames.push(frame); this.length += frame.length;
    if (voice) { this.voiced += frame.length; this.silence = 0; }
    else this.silence += frame.length;
    const limit = this.length >= this.sampleRate * 20;
    if (!limit && this.silence < this.sampleRate * 0.9) return null;
    let result: Float32Array | null = null;
    if (this.voiced >= this.sampleRate * 0.2) {
      const length = Math.min(this.sampleRate * 20, this.length);
      result = new Float32Array(length);
      let offset = 0;
      for (const part of this.frames) {
        const count = Math.min(part.length, length - offset);
        result.set(part.subarray(0, count), offset); offset += count;
        if (offset >= length) break;
      }
    }
    this.reset(); this.clipped = limit;
    return result;
  }
}

export class MicrophoneCapture {
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private node?: AudioWorkletNode;
  private detector?: UtteranceDetector;
  private disposed = false;
  private paused = false;
  private resumeAfter = 0;

  constructor(private onUtterance: (audio: Blob) => void,
    private onSpeaking: (active: boolean) => void, private onError: (message: string) => void) {}

  async start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
      throw new Error('当前环境无法录音，请使用本机桌面端或在 localhost / HTTPS 下打开新版浏览器。');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    }, video: false });
    if (this.disposed) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream;
    for (const track of stream.getAudioTracks()) track.onended = () => this.onError('麦克风已断开，请检查设备后重新开始。');
    const context = this.context = new AudioContext({ sampleRate: 16000 });
    this.detector = new UtteranceDetector(context.sampleRate);
    await context.audioWorklet.addModule(new URL('./voice-capture.worklet.js', location.href).href);
    if (this.disposed) return;
    const node = this.node = new AudioWorkletNode(context, 'caicai-voice-capture');
    node.onprocessorerror = () => this.onError('录音处理已中断，请重新开始语音聊天。');
    node.port.onmessage = event => {
      if (this.disposed || this.paused || performance.now() < this.resumeAfter) return;
      const utterance = this.detector!.push(event.data as Float32Array);
      this.onSpeaking(this.detector!.speaking);
      if (utterance) this.onUtterance(recordingBlob(utterance, context.sampleRate));
    };
    this.source = context.createMediaStreamSource(stream);
    this.source.connect(node); node.connect(context.destination);
    await context.resume();
  }

  pause(paused: boolean) {
    if (this.paused === paused) return;
    this.paused = paused; this.detector?.reset(); this.onSpeaking(false);
    if (!paused) this.resumeAfter = performance.now() + 450;
  }

  stop() {
    this.disposed = true;
    if (this.node) { this.node.port.onmessage = null; this.node.port.close(); this.node.disconnect(); }
    this.source?.disconnect();
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {});
    this.detector?.reset();
  }
}
