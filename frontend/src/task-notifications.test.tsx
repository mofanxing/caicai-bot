import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Api } from './api';
import { TaskNotifications } from './task-notifications';

const mock = vi.hoisted(() => ({ players: [] as { ended: () => void; load: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[], loadFailure: false }));
vi.mock('./playback', () => ({ SpeechPlayback: class {
  constructor(ended: () => void) { mock.players.push({ ended, load: this.load, play: this.play, pause: this.pause, dispose: this.dispose }); }
  load = vi.fn(async () => { if (mock.loadFailure) throw new Error('decode'); });
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn(); dispose = vi.fn();
} }));
vi.mock('./desktop', () => ({ subscribeDesktopState: (listener: (s: { speaking: boolean }) => void) => {
  listener({ speaking: false }); return () => {};
} }));
const job = { id: 'job1', text: '你的任务「检查项目」已完成。', status: 'completed' };
function fixture(jobs = [job]) {
  return { taskNotifications: vi.fn().mockResolvedValue(jobs), speechJob: vi.fn(async (id: string) => ({ ...job, id })),
    speechAudio: vi.fn().mockResolvedValue(new Blob()), consumeTaskNotification: vi.fn().mockResolvedValue({ deleted: true }) };
}
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); };
beforeEach(() => { localStorage.clear(); mock.players.length = 0; mock.loadFailure = false; vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('plays invisibly once and deletes only after a natural ending, including stale server responses', async () => {
  const api = fixture();
  const view = render(<TaskNotifications api={api as unknown as Api} autoRead busy={false} />);
  await act(async () => {});
  expect(view.container.innerHTML).toBe('');
  expect(mock.players[0].play).toHaveBeenCalledTimes(1);
  expect(api.consumeTaskNotification).not.toHaveBeenCalled();
  await act(async () => { mock.players[0].ended(); });
  expect(api.consumeTaskNotification).toHaveBeenCalledWith('job1');
  expect(mock.players[0].dispose).toHaveBeenCalled();
  await tick(); expect(mock.players).toHaveLength(1);
  view.unmount();
  render(<TaskNotifications api={api as unknown as Api} autoRead busy={false} />);
  await act(async () => {}); expect(mock.players).toHaveLength(1);
});

it('retries cleanup after reload without replaying finished audio', async () => {
  const api = fixture(); api.consumeTaskNotification.mockRejectedValue(new Error('offline'));
  const view = render(<TaskNotifications api={api as unknown as Api} autoRead busy={false} />);
  await act(async () => {});
  await act(async () => { mock.players[0].ended(); });
  view.unmount(); api.consumeTaskNotification.mockResolvedValue({ deleted: true });
  render(<TaskNotifications api={api as unknown as Api} autoRead busy={false} />);
  await act(async () => {});
  expect(api.consumeTaskNotification).toHaveBeenCalledTimes(2);
  expect(mock.players).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem('caicai.task-notifications.played')!).pending).toEqual([]);
});

it('pauses for chat and auto-read settings without consuming and then resumes', async () => {
  const api = fixture();
  const view = render(<TaskNotifications api={api as unknown as Api} autoRead busy />);
  await act(async () => {}); expect(mock.players).toHaveLength(0);
  view.rerender(<TaskNotifications api={api as unknown as Api} autoRead busy={false} />);
  await tick(); expect(mock.players[0].play).toHaveBeenCalledTimes(1);
  view.rerender(<TaskNotifications api={api as unknown as Api} autoRead={false} busy={false} />);
  expect(mock.players[0].pause).toHaveBeenCalledTimes(1);
  await tick(); expect(api.consumeTaskNotification).not.toHaveBeenCalled();
  view.rerender(<TaskNotifications api={api as unknown as Api} autoRead busy={false} />);
  await tick(); expect(mock.players[0].play).toHaveBeenCalledTimes(2);
  act(() => { window.dispatchEvent(new CustomEvent('caicai-audio-start', { detail: 'chat' })); });
  expect(mock.players[0].pause).toHaveBeenCalledTimes(2);
  expect(api.consumeTaskNotification).not.toHaveBeenCalled();
});

it('plays queued notifications serially and waits for synthesis', async () => {
  const api = fixture([job, { ...job, id: 'job2' }]);
  api.speechJob.mockResolvedValueOnce({ ...job, status: 'running' });
  render(<TaskNotifications api={api as unknown as Api} autoRead busy={false} />);
  await act(async () => {}); expect(mock.players).toHaveLength(0);
  await tick(); expect(mock.players).toHaveLength(1);
  await tick(); expect(mock.players).toHaveLength(1);
  await act(async () => { mock.players[0].ended(); });
  await tick(); expect(mock.players).toHaveLength(2);
  expect(api.speechAudio).toHaveBeenLastCalledWith('job2', expect.any(AbortSignal));
});

it('recovers silently from network and decoding errors without deleting unplayed audio', async () => {
  const api = fixture(); api.taskNotifications.mockRejectedValueOnce(new Error('offline'));
  const view = render(<TaskNotifications api={api as unknown as Api} autoRead busy={false} />);
  await act(async () => {});
  mock.loadFailure = true; await tick(); expect(mock.players[0].dispose).toHaveBeenCalled();
  mock.loadFailure = false; await tick(); expect(mock.players[1].play).toHaveBeenCalledTimes(1);
  expect(api.consumeTaskNotification).not.toHaveBeenCalled(); expect(view.container.innerHTML).toBe('');
});

it('discards obsolete progress after pausing and plays the completion notification', async () => {
  const api = fixture();
  const view = render(<TaskNotifications api={api as unknown as Api} autoRead busy={false} />);
  await act(async () => {});
  view.rerender(<TaskNotifications api={api as unknown as Api} autoRead busy />);
  api.taskNotifications.mockResolvedValue([{ ...job, id: 'completed' }]);
  view.rerender(<TaskNotifications api={api as unknown as Api} autoRead busy={false} />);
  await tick();
  expect(mock.players[0].dispose).toHaveBeenCalled();
  expect(api.speechAudio).toHaveBeenLastCalledWith('completed', expect.any(AbortSignal));
  expect(mock.players[1].play).toHaveBeenCalledTimes(1);
  expect(api.consumeTaskNotification).not.toHaveBeenCalled();
});
