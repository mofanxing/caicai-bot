// Keep one output context alive across asynchronous generation and sentence changes.
import { reportAudioPlayback as playing } from './desktop';
let output: AudioContext | undefined;

function context(): AudioContext {
  if (!output || output.state === 'closed') output = new AudioContext();
  return output;
}

// Call directly from click/keyboard handlers, before awaiting network or form validation.
export async function prepareSpeechPlayback(): Promise<void> {
  const audio = context();
  if (audio.state !== 'running') await audio.resume();
}

export async function decodeSpeechAudio(blob: Blob): Promise<AudioBuffer> {
  return context().decodeAudioData(await blob.arrayBuffer());
}

export class SpeechPlayback {
  private buffer?: AudioBuffer;
  private source?: AudioBufferSourceNode;
  private offset = 0;
  private started = 0;
  private generation = 0;
  private loadGeneration = 0;
  private disposed = false;
  private text = '';

  constructor(private onEnded: () => void, private kind: 'reply' | 'feedback' = 'reply') {}

  loadBuffer(buffer: AudioBuffer, text = ''): void {
    this.pause(); this.loadGeneration++; this.buffer = buffer; this.offset = 0; this.text = text;
  }

  async load(blob: Blob, text = ''): Promise<void> {
    this.pause();
    this.buffer = undefined; this.offset = 0;
    const generation = ++this.loadGeneration;
    const decoded = await context().decodeAudioData(await blob.arrayBuffer());
    if (!this.disposed && generation === this.loadGeneration) { this.buffer = decoded; this.text = text; }
  }

  async play(): Promise<void> {
    if (this.disposed || !this.buffer || this.source) return;
    const generation = this.generation;
    const audio = context();
    if (audio.state !== 'running') await audio.resume();
    if (this.disposed || generation !== this.generation || this.source) return;
    if (audio.state !== 'running') throw new DOMException('Audio output suspended', 'NotAllowedError');
    const source = audio.createBufferSource();
    source.buffer = this.buffer; source.connect(audio.destination);
    this.source = source; this.started = audio.currentTime;
    source.onended = () => {
      if (this.source !== source) return;
      this.source = undefined; this.offset = 0; source.disconnect(); playing(source, false, this.kind); this.onEnded();
    };
    try { source.start(0, this.offset); playing(source, true, this.kind, this.text); }
    catch (error) { this.source = undefined; source.disconnect(); throw error; }
  }

  pause(): void {
    // Also invalidate a pending resume(), so a late resolution cannot restart playback.
    this.generation++;
    const source = this.source;
    if (!source) return;
    this.offset = Math.min(this.buffer?.duration || 0, this.offset + context().currentTime - this.started);
    this.source = undefined; source.onended = null; source.stop(); source.disconnect();
    playing(source, false, this.kind);
  }

  dispose(): void { this.pause(); this.loadGeneration++; this.disposed = true; this.buffer = undefined; }
}
