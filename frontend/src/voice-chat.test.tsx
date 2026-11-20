import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportAudioPlayback, reportDesktopState } from './desktop';
import { VoiceChat } from './voice-chat';
import { VOICE_SETTINGS_KEY } from './voice-input';

const captures = vi.hoisted(() => [] as { emit: (audio: Blob) => void; start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }[]);
vi.mock('./voice-input', async importOriginal => ({
  ...await importOriginal<typeof import('./voice-input')>(),
  MicrophoneCapture: class {
    start = vi.fn().mockResolvedValue(undefined); stop = vi.fn(); pause = vi.fn();
    constructor(public emit: (audio: Blob) => void) { captures.push(this); }
  },
}));

beforeEach(() => {
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element));
  localStorage.clear(); captures.length = 0;
  reportDesktopState({ thinking: false, speaking: false, waiting: false });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function setup(overrides = {}) {
  const props = { api: { recognitionStatus: vi.fn().mockResolvedValue({ available: true }),
    transcribeSpeech: vi.fn().mockResolvedValue({ text: '菜菜，早上好。' }) },
    disabled: false, blocked: false, hasVoice: true, onStart: vi.fn(), onSend: vi.fn().mockResolvedValue(undefined), ...overrides };
  const view = render(<AntApp><VoiceChat {...props} /></AntApp>);
  return { ...props, ...view, redraw: (patch: Partial<typeof props>) => view.rerender(<AntApp><VoiceChat {...props} {...patch} /></AntApp>) };
}
async function start() {
  fireEvent.click(screen.getByRole('button', { name: /开始语音聊天/ }));
  await screen.findByRole('button', { name: /结束语音聊天/ });
}
async function say(text: string, api: ReturnType<typeof setup>['api']) {
  api.transcribeSpeech.mockResolvedValue({ text });
  await act(async () => { captures[0].emit(new Blob(['wav'])); });
  await waitFor(() => expect(screen.queryByText('正在本机识别…')).toBeNull());
}

describe('voice chat', () => {
  it('requires an explicit start, sends wake commands and releases the microphone on stop', async () => {
    const { api, onSend, onStart } = setup();
    expect(captures).toHaveLength(0);
    await start();
    expect(onStart).toHaveBeenCalledOnce();
    await say('这段没有唤醒词。', api);
    expect(onSend).not.toHaveBeenCalled();
    await say('菜菜，早上好。', api);
    expect(onSend).toHaveBeenCalledExactlyOnceWith('早上好。');
    fireEvent.click(screen.getByRole('button', { name: /结束语音聊天/ }));
    expect(captures[0].stop).toHaveBeenCalledOnce();
    expect(screen.getByText('语音聊天未开启')).toBeTruthy();
  });

  it('accepts a wake word by itself and the next utterance as one command', async () => {
    const { api, onSend } = setup(); await start();
    await say('菜菜。', api);
    expect(await screen.findByText('已唤醒，请在 12 秒内说出问题')).toBeTruthy();
    await say('帮我安排今天的计划。', api);
    expect(onSend).toHaveBeenCalledExactlyOnceWith('帮我安排今天的计划。');
    await say('这次需要重新唤醒。', api);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('keeps the following utterance while wake recognition is still in flight', async () => {
    const { api, onSend } = setup(); await start();
    let resolve!: (value: { text: string }) => void;
    api.transcribeSpeech.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    api.transcribeSpeech.mockResolvedValueOnce({ text: '请介绍你自己。' });
    await act(async () => { captures[0].emit(new Blob(['wake'])); captures[0].emit(new Blob(['command'])); });
    expect(api.transcribeSpeech).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ text: '菜菜' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledExactlyOnceWith('请介绍你自己。'));
  });

  it('pauses during requests, normal reply audio and feedback audio', async () => {
    const view = setup(); await start();
    view.redraw({ blocked: true });
    expect(captures[0].pause).toHaveBeenLastCalledWith(true);
    await say('菜菜，不应发送。', view.api);
    expect(view.onSend).not.toHaveBeenCalled();
    view.redraw({ blocked: false });
    const source = {};
    for (const kind of ['reply', 'feedback'] as const) {
      act(() => reportAudioPlayback(source, true, kind));
      expect(captures[0].pause).toHaveBeenLastCalledWith(true);
      await say('菜菜，不应把回答录回去。', view.api);
      expect(view.onSend).not.toHaveBeenCalled();
      act(() => reportAudioPlayback(source, false, kind));
      expect(captures[0].pause).toHaveBeenLastCalledWith(false);
    }
    await say('菜菜，现在可以发送。', view.api);
    expect(view.onSend).toHaveBeenCalledExactlyOnceWith('现在可以发送。');
  });

  it('discards a transcription that completes after stopping', async () => {
    const { api, onSend } = setup(); await start();
    let resolve!: (value: { text: string }) => void;
    api.transcribeSpeech.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    act(() => captures[0].emit(new Blob(['wav'])));
    fireEvent.click(screen.getByRole('button', { name: /结束语音聊天/ }));
    await act(async () => resolve({ text: '菜菜，不应该发送。' }));
    expect(onSend).not.toHaveBeenCalled();
    expect((api.transcribeSpeech.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
  });

  it('discards an in-flight result across a pause and resume', async () => {
    const view = setup(); await start();
    let resolve!: (value: { text: string }) => void;
    view.api.transcribeSpeech.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    act(() => captures[0].emit(new Blob(['before-pause'])));
    view.redraw({ blocked: true }); view.redraw({ blocked: false });
    await act(async () => resolve({ text: '菜菜，过期的提问。' }));
    expect(view.onSend).not.toHaveBeenCalled();
    await say('菜菜，恢复后的新问题。', view.api);
    expect(view.onSend).toHaveBeenCalledExactlyOnceWith('恢复后的新问题。');
  });

  it('supports a saved custom wake word and a direct conversation mode', async () => {
    localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify({ wakeEnabled: true, wakeWord: '小助手' }));
    const { api, onSend } = setup(); await start();
    await say('菜菜，旧唤醒词不生效。', api);
    expect(onSend).not.toHaveBeenCalled();
    await say('小助手，新的唤醒词。', api);
    expect(onSend).toHaveBeenCalledWith('新的唤醒词。');
    fireEvent.click(screen.getByRole('button', { name: /语音设置/ }));
    fireEvent.click(screen.getByRole('switch', { name: '启用唤醒词' }));
    fireEvent.click(screen.getByRole('button', { name: '保存语音设置' }));
    expect(JSON.parse(localStorage.getItem(VOICE_SETTINGS_KEY)!).wakeEnabled).toBe(false);
    api.transcribeSpeech.mockResolvedValue({ text: '早上好。' });
    await start();
    await act(async () => { captures[1].emit(new Blob(['wav'])); });
    expect(onSend).toHaveBeenLastCalledWith('早上好。');
  });

  it('shows a setup hint without opening the microphone if the model is unavailable', async () => {
    const api = { recognitionStatus: vi.fn().mockResolvedValue({ available: false, detail: '本地模型未安装' }),
      transcribeSpeech: vi.fn() };
    setup({ api });
    fireEvent.click(screen.getByRole('button', { name: /开始语音聊天/ }));
    expect(await screen.findByText(/本地模型未安装/)).toBeTruthy();
    expect(captures[0].start).not.toHaveBeenCalled();
    expect(captures[0].stop).toHaveBeenCalledOnce();
  });

  it('stops capture and shows recognition errors without replaying commands', async () => {
    const { api, onSend } = setup(); await start();
    api.transcribeSpeech.mockRejectedValueOnce(new Error('识别服务已退出'));
    await act(async () => captures[0].emit(new Blob(['wav'])));
    expect(await screen.findByText('识别服务已退出')).toBeTruthy();
    expect(captures[0].stop).toHaveBeenCalledOnce(); expect(onSend).not.toHaveBeenCalled();
  });

  it('releases capture on unmount and cancels status requests', async () => {
    const { unmount, api } = setup(); await start();
    unmount();
    expect(captures[0].stop).toHaveBeenCalledOnce();
    await waitFor(() => expect((api.recognitionStatus.mock.calls[0][0] as AbortSignal).aborted).toBe(true));
  });
});
