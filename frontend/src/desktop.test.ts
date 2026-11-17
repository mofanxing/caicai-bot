import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { history.replaceState(null, '', '/'); vi.unstubAllGlobals(); vi.resetModules(); });

it('桌面会话及流式发送使用正式接口，进程令牌不进入 URL', async () => {
  history.replaceState(null, '', '/chat/#token=pet-capability');
  vi.resetModules();
  const fetchMock = vi.fn().mockImplementation((path: string) => Promise.resolve(path.endsWith('/stream')
    ? new Response('data: {"type":"done","message":{"id":"m1","status":"completed"}}\n\n')
    : new Response('{"id":"c1"}')));
  vi.stubGlobal('fetch', fetchMock);
  const { createApi } = await import('./api');
  const api = createApi('admin-token');
  expect(location.hash).toBe('');
  await api.addConversation('日常');
  await api.sendStream('c1', '你好', 'once', vi.fn());
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ channel: 'desktop', account_id: 'desktop', peer_id: '日常' });
  expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/desktop/conversations/c1/messages/stream');
  for (const [url, init] of fetchMock.mock.calls) {
    expect(url).not.toContain('pet-capability');
    expect(init.headers['X-DSH-Pet-Token']).toBe('pet-capability');
    expect(init.headers.Authorization).toBe('Bearer admin-token');
  }
});

it('文字生成和真实出声状态分别保存，并按顺序提交完整快照', async () => {
  history.replaceState(null, '', '/chat/#token=pet-capability'); vi.resetModules();
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}')); vi.stubGlobal('fetch', fetchMock);
  const { reportDesktopState, reportAudioPlayback } = await import('./desktop');
  const source = {};
  reportDesktopState({ thinking: true }); reportAudioPlayback(source, true);
  reportDesktopState({ thinking: false }); reportAudioPlayback(source, false);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body))).toEqual([
    { thinking: true, speaking: false, waiting: false },
    { thinking: true, speaking: true, waiting: false },
    { thinking: false, speaking: true, waiting: false },
    { thinking: false, speaking: false, waiting: false },
  ]);
});
