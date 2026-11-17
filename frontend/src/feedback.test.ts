import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaitingFeedback, FeedbackConfiguration } from './feedback';
import type { Api } from './api';

const { play, pause, dispose, decode, loadBuffer } = vi.hoisted(() => ({
  play: vi.fn(), pause: vi.fn(), dispose: vi.fn(), decode: vi.fn(), loadBuffer: vi.fn(),
}));
vi.mock('./playback', () => ({
  decodeSpeechAudio: decode,
  SpeechPlayback: class {
    play = play; pause = pause; dispose = dispose; loadBuffer = loadBuffer;
  },
}));
let feedback: WaitingFeedback | undefined;
let api: Api;
let config: FeedbackConfiguration;
const clips = { voice_id: 'voice', style_prompt: '轻松自然',
  thinking: { id: 'thinking', text: '想一想', status: 'completed' }, waiting: { id: 'waiting', text: '稍等', status: 'completed' } };

beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules(); history.replaceState(null, '', '/chat/#token=desktop-only');
  for (const mock of [play, pause, dispose, decode, loadBuffer]) mock.mockReset();
  play.mockResolvedValue(undefined); decode.mockResolvedValue({ duration: 1 });
  vi.stubGlobal('fetch', vi.fn());
  api = { feedback: vi.fn().mockResolvedValue(clips), speechAudio: vi.fn().mockResolvedValue(new Blob(['wav'])),
    speechJob: vi.fn(), retrySpeechJob: vi.fn() } as unknown as Api;
  config = { api, conversationId: 'conversation', voiceId: 'voice', stylePrompt: '轻松自然', thinkingText: '想一想', waitingText: '稍等', thinkingJobId: 'thinking', waitingJobId: 'waiting' };
});
afterEach(() => { feedback?.dispose(); feedback = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });

async function setup() {
  const { createWaitingFeedback } = await import('./feedback');
  const desktop = await import('./desktop');
  const status = vi.fn();
  feedback = createWaitingFeedback(status)!; feedback.configure(true, config);
  await vi.advanceTimersByTimeAsync(0);
  return { ...desktop, status };
}

describe('desktop waiting voice', () => {
  it('prepares configured clips once and acknowledges thinking without another API request', async () => {
    const { reportDesktopState, status } = await setup();
    expect(api.feedback).toHaveBeenCalledWith('conversation', expect.any(AbortSignal));
    expect(api.speechAudio).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith('ready');
    feedback!.configure(true, { ...config });
    expect(api.feedback).toHaveBeenCalledTimes(1);
    reportDesktopState({ thinking: true });
    await vi.advanceTimersByTimeAsync(179); expect(play).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(play).toHaveBeenCalledTimes(1);
    reportDesktopState({ waiting: true }); await vi.advanceTimersByTimeAsync(2000);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('acknowledges speech preparation once after a sustained wait, without looping across buffering changes', async () => {
    const { reportDesktopState } = await setup();
    reportDesktopState({ thinking: true }); await vi.advanceTimersByTimeAsync(180);
    reportDesktopState({ thinking: false, waiting: true });
    await vi.advanceTimersByTimeAsync(1199); expect(play).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(play).toHaveBeenCalledTimes(2);
    reportDesktopState({ waiting: false }); reportDesktopState({ waiting: true });
    await vi.advanceTimersByTimeAsync(6000); expect(play).toHaveBeenCalledTimes(2);
    reportDesktopState({ thinking: true }); await vi.advanceTimersByTimeAsync(180);
    expect(play).toHaveBeenCalledTimes(3);
  });

  it('cancels pending cues for fast replies and never speaks over the real answer', async () => {
    const { reportDesktopState, reportAudioPlayback } = await setup();
    reportDesktopState({ thinking: true }); await vi.advanceTimersByTimeAsync(80);
    reportAudioPlayback({}, true); await vi.advanceTimersByTimeAsync(5000);
    expect(play).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalled();
    reportDesktopState({ speaking: false, thinking: false, waiting: true });
    await vi.advanceTimersByTimeAsync(5000); expect(play).not.toHaveBeenCalled();
  });

  it('stops an active cue synchronously before reply playback, preview or manual stop', async () => {
    const { reportDesktopState } = await setup();
    reportDesktopState({ thinking: true }); await vi.advanceTimersByTimeAsync(180);
    pause.mockClear();
    window.dispatchEvent(new CustomEvent('caicai-audio-start', { detail: '' }));
    expect(pause).toHaveBeenCalled();
    reportDesktopState({ thinking: false, waiting: true }); await vi.advanceTimersByTimeAsync(3000);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('does not play a late decoded acknowledgement after the stage has ended', async () => {
    let resolveBuffer!: (buffer: AudioBuffer) => void;
    decode.mockImplementationOnce(() => new Promise<AudioBuffer>(resolve => { resolveBuffer = resolve; }));
    const { reportDesktopState } = await setup();
    reportDesktopState({ thinking: true }); await vi.advanceTimersByTimeAsync(180);
    reportDesktopState({ thinking: false });
    resolveBuffer({ duration: 1 } as AudioBuffer); await vi.advanceTimersByTimeAsync(0);
    expect(play).not.toHaveBeenCalled();
  });

  it('respects mute and disposal and does not acknowledge restored history', async () => {
    const { reportDesktopState } = await setup();
    reportDesktopState({ waiting: true }); await vi.advanceTimersByTimeAsync(3000);
    expect(play).not.toHaveBeenCalled();
    feedback!.configure(false); reportDesktopState({ thinking: true });
    await vi.advanceTimersByTimeAsync(3000); expect(play).not.toHaveBeenCalled();
    reportDesktopState({ thinking: false }); feedback!.configure(true, config);
    reportDesktopState({ thinking: true }); feedback!.dispose();
    await vi.advanceTimersByTimeAsync(3000); expect(play).not.toHaveBeenCalled();
  });

  it('never starts generation or retries when configured clips are missing or failed', async () => {
    vi.mocked(api.feedback).mockResolvedValue({ ...clips, thinking: null, waiting: null });
    const { reportDesktopState, status } = await setup();
    expect(status).toHaveBeenLastCalledWith('missing');
    reportDesktopState({ thinking: true }); await vi.advanceTimersByTimeAsync(2000);
    expect(play).not.toHaveBeenCalled();
    expect(api.retrySpeechJob).not.toHaveBeenCalled();
    vi.mocked(api.feedback).mockResolvedValue({ ...clips, thinking: { ...clips.thinking, status: 'failed' } } as never);
    feedback!.configure(false, config); feedback!.configure(true, config);
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenLastCalledWith('failed');
    expect(api.retrySpeechJob).not.toHaveBeenCalled();
  });

  it('invalidates cached audio when manual generation replaces job ids', async () => {
    const { reportDesktopState } = await setup();
    reportDesktopState({ thinking: true }); await vi.advanceTimersByTimeAsync(180);
    pause.mockClear();
    vi.mocked(api.feedback).mockResolvedValue({ ...clips, thinking: { ...clips.thinking, id: 'new-thinking' } } as never);
    feedback!.configure(true, { ...config, thinkingJobId: 'new-thinking' });
    expect(pause).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(play).toHaveBeenCalledTimes(1);
    expect(api.feedback).toHaveBeenCalledTimes(2);
  });

  it('polls queued clips before declaring them ready', async () => {
    vi.mocked(api.feedback).mockResolvedValue({ ...clips,
      thinking: { ...clips.thinking, status: 'queued' },
    } as never);
    vi.mocked(api.speechJob).mockResolvedValue(clips.thinking as never);
    const { status } = await setup();
    expect(status).toHaveBeenLastCalledWith('preparing');
    await vi.advanceTimersByTimeAsync(500);
    expect(api.speechJob).toHaveBeenCalledWith('thinking', expect.any(AbortSignal));
    expect(status).toHaveBeenLastCalledWith('ready');
  });

  it('rejects a server response for a different saved voice configuration', async () => {
    vi.mocked(api.feedback).mockResolvedValue({ ...clips, style_prompt: '旧提示词' } as never);
    const { status, reportDesktopState } = await setup();
    expect(status).toHaveBeenLastCalledWith('failed');
    reportDesktopState({ thinking: true }); await vi.advanceTimersByTimeAsync(3000);
    expect(api.speechAudio).not.toHaveBeenCalled(); expect(play).not.toHaveBeenCalled();
  });

  it('aborts previous preparation and discards late decoded audio on a config switch', async () => {
    let resolveBuffer!: (buffer: AudioBuffer) => void;
    decode.mockImplementationOnce(() => new Promise<AudioBuffer>(resolve => { resolveBuffer = resolve; }));
    const { reportDesktopState } = await setup();
    const signal = vi.mocked(api.feedback).mock.calls[0][1]!;
    reportDesktopState({ thinking: true });
    vi.mocked(api.feedback).mockResolvedValue({ ...clips, voice_id: 'new-voice', style_prompt: '新语气' } as never);
    feedback!.configure(true, { ...config, voiceId: 'new-voice', stylePrompt: '新语气' });
    expect(signal.aborted).toBe(true);
    resolveBuffer({ duration: 9 } as AudioBuffer); await vi.advanceTimersByTimeAsync(3000);
    expect(play).not.toHaveBeenCalled();
    reportDesktopState({ thinking: false }); reportDesktopState({ thinking: true });
    await vi.advanceTimersByTimeAsync(180);
    expect(loadBuffer).toHaveBeenCalledWith({ duration: 1 }, '想一想');
  });

  it('cancels pending polls on mute and ignores late results', async () => {
    vi.mocked(api.feedback).mockResolvedValue({ ...clips,
      thinking: { ...clips.thinking, status: 'queued' },
    } as never);
    const { status } = await setup();
    feedback!.configure(false, config); await vi.advanceTimersByTimeAsync(2000);
    expect(api.speechJob).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith('idle');
  });

  it('does not enable this desktop feature in the browser workbench', async () => {
    history.replaceState(null, '', '/');
    const { createWaitingFeedback } = await import('./feedback');
    expect(createWaitingFeedback()).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
