import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Api } from './api';
import type { TaskRecord } from './types';
import { TaskCards, TaskComposer, TaskInspector, TasksPage } from './tasks';

vi.mock('./desktop', () => ({ isDesktop: true, selectProjectDirectory: vi.fn() }));
import { selectProjectDirectory } from './desktop';

beforeEach(() => {
  const computed = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computed(element));
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {} })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const task = { id: 't1', conversation_id: 'c1', project_id: 'p1', project_root: '/project',
  goal: '修复测试', agent_id: 'caicai.deepseek/coding', status: 'succeeded', result: '修复已完成',
  reason: null, event_seq: 502, created_at: '2026-11-18T10:00:00Z', updated_at: '2026-11-18T10:01:00Z',
  timeout_seconds: 600 } as TaskRecord;

it('drains paginated events, shows failed check separately from completed executor, and aborts on close', async () => {
  let signal: AbortSignal | undefined;
  const taskEvents = vi.fn(async (_id: string, after: number, abort: AbortSignal) => {
    signal = abort;
    return after === 0 ? Array.from({ length: 500 }, (_, i) => ({ seq: i + 1, type: 'progress',
      occurred_at: '2026-11-18T10:00:00Z', payload: { message: '步骤 ' + (i + 1) } })) : [
      { seq: 501, type: 'progress', occurred_at: '2026-11-18T10:01:00Z',
        payload: { command: 'pytest -q', output: '1 failed', exit_code: 1 } },
      { seq: 502, type: 'task.finished', occurred_at: '2026-11-18T10:01:00Z', payload: {} }];
  });
  const api = { taskDetail: vi.fn(async () => ({ task, attempts: [], artifacts: [
    { id: 'a1', path: 'calculator.py', kind: 'update', sha256: 'hash' }] })), taskEvents } as unknown as Api;
  const view = render(<App><TaskInspector api={api} id="t1" onClose={() => {}} /></App>);
  expect(await screen.findByText('修复已完成')).toBeTruthy();
  expect(taskEvents).toHaveBeenCalledTimes(2);
  expect(taskEvents.mock.calls[1][1]).toBe(500);
  expect(screen.getByText('退出码 1')).toBeTruthy();
  expect(screen.getByText('calculator.py')).toBeTruthy();
  expect(screen.getByText('pytest -q')).toBeTruthy();
  view.unmount();
  expect(signal?.aborted).toBe(true);
});

it('cancels a running task and keeps persisted execution details available', async () => {
  let cancelled = false;
  const cancelTask = vi.fn(async () => { cancelled = true; return task; });
  const api = { taskDetail: vi.fn(async () => ({ task: { ...task, status: cancelled ? 'cancelled' : 'running', event_seq: 0 },
    attempts: [], artifacts: [] })), taskEvents: vi.fn(async () => []), cancelTask } as unknown as Api;
  render(<App><TaskInspector api={api} id="t1" onClose={() => {}} /></App>);
  fireEvent.click(await screen.findByRole('button', { name: '取消任务' }));
  await waitFor(() => expect(cancelTask).toHaveBeenCalledWith('t1'));
  expect(await screen.findByText('已取消')).toBeTruthy();
});

it('filters task cards to the current conversation and displays fetch failures', async () => {
  const tasks = vi.fn().mockResolvedValueOnce([{ ...task, status: 'running' }]).mockRejectedValue(new Error('连接中断'));
  const api = { tasks } as unknown as Api;
  const view = render(<App><TaskCards api={api} conversationId="c1" /></App>);
  expect(await screen.findByText('修复测试')).toBeTruthy();
  expect(tasks.mock.calls[0][0]).toBe('c1');
  view.rerender(<App><TaskCards api={api} conversationId="c2" /></App>);
  expect(await screen.findByText('连接中断')).toBeTruthy();
  expect(screen.queryByText('修复测试')).toBeNull();
});

it('preserves the task goal and blocks submission when the executor is not ready', async () => {
  const createTask = vi.fn();
  const api = { taskProjects: vi.fn(async () => []), taskPlugins: vi.fn(async () => []), createTask } as unknown as Api;
  render(<App><TaskComposer api={api} conversations={[]} draft="检查当前项目测试" open
    onClose={() => {}} onCreated={() => {}} /></App>);
  await waitFor(() => expect(screen.getByRole('textbox', { name: '任务目标与验收条件' })).toBeTruthy());
  expect((screen.getByRole('textbox', { name: '任务目标与验收条件' }) as HTMLTextAreaElement).value).toBe('检查当前项目测试');
  expect((screen.getByRole('button', { name: '创建后台任务' }) as HTMLButtonElement).disabled).toBe(true);
  expect(createTask).not.toHaveBeenCalled();
});

it('selects a native directory, fills its name, and preserves the chosen path on cancel', async () => {
  vi.mocked(selectProjectDirectory).mockResolvedValueOnce('/Users/demo/我的项目').mockResolvedValueOnce(null);
  const addTaskProject = vi.fn(async () => ({}));
  const api = { taskPlugins: vi.fn(async () => []), taskProjects: vi.fn(async () => []),
    taskRuntime: vi.fn(async () => ({ mode: 'managed', state: 'running' })),
    tasks: vi.fn(async () => []), addTaskProject } as unknown as Api;
  render(<App><TasksPage api={api} conversations={[]} /></App>);
  fireEvent.click(await screen.findByRole('button', { name: /选择文件夹/ }));
  await waitFor(() => expect((screen.getByRole('textbox', { name: '项目绝对目录' }) as HTMLInputElement).value).toBe('/Users/demo/我的项目'));
  fireEvent.click(screen.getByRole('button', { name: /选择文件夹/ }));
  await waitFor(() => expect(vi.mocked(selectProjectDirectory)).toHaveBeenCalledTimes(2));
  expect((screen.getByRole('textbox', { name: '项目绝对目录' }) as HTMLInputElement).value).toBe('/Users/demo/我的项目');
  fireEvent.click(screen.getByRole('button', { name: '登记项目' }));
  await waitFor(() => expect(addTaskProject).toHaveBeenCalledWith('我的项目', '/Users/demo/我的项目'));
}, 15000);

it('confirms project removal and refreshes registrations without clearing task history', async () => {
  let projects = [{ id: 'p1', name: '测试项目', root: '/project' }];
  const deleteTaskProject = vi.fn(async () => { projects = []; return { deleted: true }; });
  const api = { taskPlugins: vi.fn(async () => []), taskProjects: vi.fn(async () => projects),
    taskRuntime: vi.fn(async () => ({ mode: 'managed', state: 'running' })),
    tasks: vi.fn(async () => [task]), deleteTaskProject } as unknown as Api;
  render(<App><TasksPage api={api} conversations={[]} /></App>);
  fireEvent.click(await screen.findByRole('button', { name: '删除项目测试项目' }));
  expect(deleteTaskProject).not.toHaveBeenCalled();
  expect(await screen.findByText(/只移除任务中心的登记，不删除磁盘文件/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /删除登记/ }));
  await waitFor(() => expect(deleteTaskProject).toHaveBeenCalledWith('p1'));
  await waitFor(() => expect(screen.queryByRole('button', { name: '删除项目测试项目' })).toBeNull());
  expect(screen.getByText('修复测试')).toBeTruthy();
}, 15000);

it('hides ended tasks only in chat while retaining them in the task center', async () => {
  const api = { tasks: vi.fn(async () => [task, { ...task, id: 'live', goal: '进行中的任务', status: 'running' }]) } as unknown as Api;
  const view = render(<App><TaskCards api={api} conversationId="c1" /></App>);
  expect(await screen.findByText('进行中的任务')).toBeTruthy();
  expect(screen.queryByText('修复测试')).toBeNull();
  view.rerender(<App><TaskCards api={api} /></App>);
  expect(await screen.findByText('修复测试')).toBeTruthy();
});
