import type { Api } from './api';
import { isDesktop, subscribeDesktopState, type DesktopState } from './desktop';
import { decodeSpeechAudio, SpeechPlayback } from './playback';
import type { SpeechJob } from './types';

type Phase = 'thinking' | 'waiting';
export type FeedbackStatus = 'idle' | 'missing' | 'preparing' | 'ready' | 'failed';
export interface FeedbackConfiguration {
  api: Api;
  conversationId: string;
  voiceId: string;
  stylePrompt: string;
  thinkingText: string;
  waitingText: string;
  thinkingJobId?: string | null;
  waitingJobId?: string | null;
}

function delay(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 500);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export class WaitingFeedback {
  private player = new SpeechPlayback(() => {}, 'feedback');
  private buffers = new Map<Phase, AudioBuffer>();
  private controller?: AbortController;
  private configuration?: FeedbackConfiguration;
  private key?: string;
  private state: DesktopState = { thinking: false, waiting: false, speaking: false };
  private enabled = false;
  private disposed = false;
  private activeTurn = false;
  private suppressed = false;
  private answered = false;
  private said = new Set<Phase>();
  private timer?: ReturnType<typeof setTimeout>;
  private phase?: Phase;
  private epoch = 0;
  private generation = 0;
  private unsubscribe: () => void;

  constructor(private status: (value: FeedbackStatus) => void = () => {}) {
    this.unsubscribe = subscribeDesktopState(state => this.update(state));
    window.addEventListener('caicai-audio-start', this.onOtherPlayback);
  }

  private onOtherPlayback = () => {
    if (this.activeTurn) this.suppressed = true;
    this.stop();
  };

  configure(enabled: boolean, configuration?: FeedbackConfiguration) {
    if (this.disposed) return;
    enabled = enabled && !!configuration;
    const key = configuration && JSON.stringify([
      configuration.conversationId, configuration.voiceId, configuration.stylePrompt,
      configuration.thinkingText, configuration.waitingText, configuration.thinkingJobId, configuration.waitingJobId,
    ]);
    const changed = key !== this.key || configuration?.api !== this.configuration?.api;
    const wasEnabled = this.enabled;
    this.enabled = enabled;
    if (changed || !enabled) {
      this.stop(); this.activeTurn = false; this.generation++;
      this.controller?.abort(); this.controller = undefined; this.buffers.clear();
      this.configuration = configuration; this.key = key; this.status('idle');
    }
    if (enabled && (changed || !wasEnabled)) void this.prepare();
    this.schedule();
  }

  private async prepare() {
    const config = this.configuration;
    if (!config) return;
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    const generation = ++this.generation;
    const current = () => !this.disposed && this.enabled && generation === this.generation;
    this.status('preparing');
    try {
      const clips = await config.api.feedback(config.conversationId, controller.signal);
      if (!current()) return;
      if (clips.voice_id !== config.voiceId || clips.style_prompt !== config.stylePrompt) {
        throw new Error('voice_configuration_changed');
      }
      if (!clips.thinking || !clips.waiting) { this.status('missing'); return; }
      if (clips.thinking.text !== config.thinkingText || clips.waiting.text !== config.waitingText
        || clips.thinking.id !== config.thinkingJobId || clips.waiting.id !== config.waitingJobId) {
        throw new Error('feedback_configuration_changed');
      }
      const results = await Promise.allSettled((['thinking', 'waiting'] as const).map(async phase => {
        let job: SpeechJob = clips[phase]!;
        while (current() && (job.status === 'queued' || job.status === 'running')) {
          await delay(controller.signal);
          job = await config.api.speechJob(job.id, controller.signal);
        }
        if (!current()) return;
        if (job.status !== 'completed') throw new Error('feedback_generation_failed');
        const blob = await config.api.speechAudio(job.id, controller.signal);
        if (!current()) return;
        const buffer = await decodeSpeechAudio(blob);
        if (!current()) return;
        this.buffers.set(phase, buffer); this.schedule();
      }));
      if (!current()) return;
      this.status(results.some(result => result.status === 'rejected') ? 'failed' : 'ready');
    } catch {
      if (current()) this.status('failed');
    }
  }

  private update(state: DesktopState) {
    if (state.thinking && !this.state.thinking) {
      this.stop(); this.activeTurn = this.enabled; this.suppressed = false; this.answered = false; this.said.clear();
    }
    this.state = state;
    if (state.speaking) { this.answered = true; this.stop(); return; }
    this.schedule();
  }

  private schedule() {
    const phase: Phase | undefined = this.state.thinking ? 'thinking' : this.state.waiting ? 'waiting' : undefined;
    if (this.disposed || !this.enabled || !this.activeTurn || this.suppressed || this.answered || !phase) { this.stop(); return; }
    if (this.phase === phase) return;
    this.stop();
    if (this.said.has(phase) || !this.buffers.has(phase)) return;
    this.phase = phase;
    const epoch = this.epoch;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed || epoch !== this.epoch || this.said.has(phase)) return;
      const buffer = this.buffers.get(phase);
      if (!buffer) return;
      this.said.add(phase); this.player.loadBuffer(buffer);
      void this.player.play().catch(() => {});
    }, phase === 'thinking' ? 180 : 1200);
  }

  stop() {
    this.epoch++; clearTimeout(this.timer); this.timer = undefined; this.phase = undefined; this.player.pause();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.stop(); this.controller?.abort(); this.unsubscribe();
    window.removeEventListener('caicai-audio-start', this.onOtherPlayback); this.player.dispose();
  }
}

export function createWaitingFeedback(status?: (value: FeedbackStatus) => void) {
  return isDesktop ? new WaitingFeedback(status) : undefined;
}
