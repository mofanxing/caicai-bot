import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App as AntApp } from 'antd';
import { SpeechJobPlayer, SpeechPlaylist, stopSpeechPlayback, VoicesPage } from './speech';
import type { Api } from './api';
import type { SpeechJob } from './types';
import * as desktop from './desktop';

const { play, pause, dispose, prepare, players } = vi.hoisted(() => ({
  play: vi.fn<() => Promise<void>>(), pause: vi.fn(), dispose: vi.fn(),
  prepare: vi.fn<() => Promise<void>>(), players: [] as { onEnded: () => void }[],
}));
vi.mock('./playback', () => ({
  prepareSpeechPlayback: prepare,
  decodeSpeechAudio: vi.fn(async () => ({ duration: 9 })),
  SpeechPlayback: class {
    constructor(public onEnded: () => void) { players.push(this); }
    load = vi.fn().mockResolvedValue(undefined);
    loadBuffer = vi.fn();
    play = play; pause = pause; dispose = dispose;
  },
}));

beforeEach(() => {
  play.mockReset().mockResolvedValue(undefined); pause.mockReset();
  prepare.mockReset().mockResolvedValue(undefined); dispose.mockReset(); players.length = 0;
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  URL.createObjectURL = vi.fn(() => 'blob:local-audio');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function job(id: string, status: SpeechJob['status'] = 'completed'): SpeechJob {
  return { id, status, voice_id: 'v1', message_id: 'm1', text: '你好。', style_prompt: '',
    error: status === 'failed' ? '合成失败' : null, duration_seconds: 1, generation_seconds: 0.1, created_at: '' };
}
function apiMock() {
  return { speechJob: vi.fn(async (id: string) => job(id)),
    speechAudio: vi.fn(async () => new Blob(['audio'])),
    retrySpeechJob: vi.fn(async (id: string) => job(id)),
  } as unknown as Api;
}

describe('sentence playback queue', () => {
  it('keeps the waiting stage continuous across job status changes and clears it on unmount', async () => {
    const waiting = vi.spyOn(desktop, 'reportSpeechWaiting');
    try {
      const api = apiMock(); let status: SpeechJob['status'] = 'running';
      vi.mocked(api.speechJob).mockImplementation(async id => job(id, status));
      const view = render(<SpeechPlaylist api={api} jobIds={['j1']} autoPlay streaming />);
      await waitFor(() => expect(api.speechJob).toHaveBeenCalled());
      status = 'completed';
      await waitFor(() => expect(api.speechAudio).toHaveBeenCalledWith('j1'), { timeout: 2000 });
      expect(waiting.mock.calls.some(([, active]) => !active)).toBe(false);
      view.unmount(); expect(waiting.mock.calls.at(-1)?.[1]).toBe(false);
    } finally { waiting.mockRestore(); }
  });

  it('buffers the short opening and preloads the next sentence before starting smooth playback', async () => {
    const api = apiMock();
    const view = render(<SpeechPlaylist api={api} jobIds={['j1']} autoPlay streaming />);
    await waitFor(() => expect(api.speechAudio).toHaveBeenCalledWith('j1'));
    expect(play).not.toHaveBeenCalled();
    view.rerender(<SpeechPlaylist api={api} jobIds={['j1', 'j2']} autoPlay streaming />);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(api.speechAudio).toHaveBeenCalledWith('j2');
    const calls = vi.mocked(api.speechAudio).mock.calls.length;
    act(() => players[0].onEnded());
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(api.speechAudio).toHaveBeenCalledTimes(calls);
  });

  it('waits for complete generation when synthesis is slower than speaking', async () => {
    const api = apiMock();
    vi.mocked(api.speechJob).mockImplementation(async id => ({ ...job(id),
      duration_seconds: 2, generation_seconds: 4 }));
    const view = render(<SpeechPlaylist api={api} jobIds={['j1', 'j2']} autoPlay streaming />);
    await screen.findByText('合成慢于播报，正在缓冲完整回复以减少断句…');
    await waitFor(() => expect(api.speechAudio).toHaveBeenCalledWith('j2'));
    expect(play).not.toHaveBeenCalled();
    view.rerender(<SpeechPlaylist api={api} jobIds={['j1', 'j2']} autoPlay />);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  });

  it('does not restart the current sentence when the next audio is decoded', async () => {
    const api = apiMock();
    const view = render(<SpeechPlaylist api={api} jobIds={['j1']} autoPlay streaming playbackMode="realtime" />);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    view.rerender(<SpeechPlaylist api={api} jobIds={['j1', 'j2']} autoPlay streaming playbackMode="realtime" />);
    await waitFor(() => expect(api.speechAudio).toHaveBeenCalledWith('j2'));
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('plays the first sentence before streaming ends, then plays later sentences in order', async () => {
    const api = apiMock();
    const view = render(<SpeechPlaylist api={api} jobIds={['j1']} autoPlay streaming playbackMode="realtime" />);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    act(() => players[0].onEnded());
    expect(screen.getByText('等待下一段语音…')).toBeTruthy();
    view.rerender(<SpeechPlaylist api={api} jobIds={['j1', 'j2']} autoPlay streaming playbackMode="realtime" />);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.speechAudio).mock.calls.map(call => call[0])).toEqual(['j1', 'j2']);
    view.rerender(<SpeechPlaylist api={api} jobIds={['j1', 'j2']} autoPlay playbackMode="realtime" />);
    act(() => players[0].onEnded());
    expect(screen.getByText('朗读完成')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /重新朗读/ }));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(3));
    view.unmount();
    expect(dispose).toHaveBeenCalled();
    expect(pause).toHaveBeenCalled();
  });

  it('does not autoplay historical messages and allows manual playback', async () => {
    const view = render(<SpeechPlaylist api={apiMock()} jobIds={['j1']} />);
    await screen.findByText('第 1 段 · 已就绪');
    expect(play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /开始朗读/ }));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    act(() => stopSpeechPlayback());
    expect(screen.getByRole('button', { name: /开始朗读/ })).toBeTruthy();
  });

  it('pauses when autoplay is switched off and does not resume when another segment arrives', async () => {
    const api = apiMock();
    const view = render(<SpeechPlaylist api={api} jobIds={['j1']} autoPlay streaming playbackMode="realtime" />);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    view.rerender(<SpeechPlaylist api={api} jobIds={['j1']} streaming playbackMode="realtime" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /开始朗读/ })).toBeTruthy());
    view.rerender(<SpeechPlaylist api={api} jobIds={['j1', 'j2']} streaming playbackMode="realtime" />);
    await waitFor(() => expect(api.speechJob).toHaveBeenCalledWith('j2'));
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('offers manual playback when the browser blocks autoplay', async () => {
    play.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
    render(<SpeechPlaylist api={apiMock()} jobIds={['j1']} autoPlay />);
    expect(await screen.findByText(/浏览器暂未允许自动播放/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /开始朗读/ }));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
  });

  it('retries a failed segment without requesting a new chat reply', async () => {
    const api = apiMock();
    vi.mocked(api.speechJob).mockResolvedValueOnce(job('j1', 'failed'));
    render(<SpeechPlaylist api={api} jobIds={['j1']} />);
    fireEvent.click(await screen.findByRole('button', { name: /重试语音/ }));
    await waitFor(() => expect(api.retrySpeechJob).toHaveBeenCalledWith('j1'));
    await waitFor(() => expect(api.speechAudio).toHaveBeenCalledWith('j1'));
  });

  it('automatically plays a freshly generated preview', async () => {
    render(<SpeechJobPlayer api={apiMock()} jobId="preview" autoPlay />);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  });

  it('generates and automatically plays a preview after the original click', async () => {
    const api = Object.assign(apiMock(), {
      speechJobs: vi.fn().mockResolvedValue([]),
      speechStatus: vi.fn().mockResolvedValue({ available: true, model: 'test', detail: 'ready' }),
      previewVoice: vi.fn(async () => {
        expect(prepare).toHaveBeenCalled();
        return job('preview', 'queued');
      }),
    });
    render(<AntApp><VoicesPage api={api} voices={[{ id: 'v1', name: '测试音色',
      style_prompt: '', reference_text: '', duration_seconds: 5, created_at: '' }]}
      onChanged={async () => {}} /></AntApp>);
    const button = await screen.findByRole('button', { name: /生成并自动试听/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(prepare).toHaveBeenCalled();
    await waitFor(() => expect(api.previewVoice).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  });
});
