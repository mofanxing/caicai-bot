import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, request } from './api';
import { waitFor } from '@testing-library/react';

afterEach(() => { vi.unstubAllGlobals(); });

describe('backend API client', () => {
  it('decodes split UTF-8 SSE frames and delivers text before completion', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body));
    vi.stubGlobal('fetch', fetchMock);
    const events = vi.fn();
    const promise = createApi('token').sendStream('c1', '你好', 'stream-id', events);
    const bytes = new TextEncoder().encode(': keepalive\r\n\r\ndata: {"type":"delta","text":"你好。"}\r\n\r\n');
    for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2));
    await waitFor(() => expect(events).toHaveBeenCalledWith({ type: 'delta', text: '你好。' }));
    const result = { id: 'm1', status: 'completed', assistant_text: '你好。' };
    controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type: 'done', message: result }) + '\n\n'));
    await expect(promise).resolves.toEqual(result);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer token');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).external_id).toBe('stream-id');
  });

  it('reports stream failures and early disconnects without retrying the request', async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Response('data: {"type":"error","message":"模型超时"}\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createApi('token').sendStream('c1', '你好', 'id', vi.fn())).rejects.toThrow('模型超时');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(new Response('data: {"type":"delta","text":"部分回答"}\n\n'));
    await expect(createApi('token').sendStream('c1', '你好', 'id', vi.fn())).rejects.toThrow('回复连接中断');
  });
  it('uploads multipart audio without overriding its boundary and authenticates blob reads', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'v1' })))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/wav' } }));
    vi.stubGlobal('fetch', fetchMock);
    const api = createApi('private-token');
    const body = new FormData(); body.append('name', 'voice'); body.append('audio', new Blob(['wav']), 'ref.wav');
    await api.uploadVoice(body);
    expect(fetchMock.mock.calls[0][1].body).toBe(body);
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBeUndefined();
    const blob = await api.speechAudio('j1');
    expect(blob.type).toBe('audio/wav');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/speech/jobs/j1/audio');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer private-token');
    expect(fetchMock.mock.calls[1][0]).not.toContain('private-token');
  });

  it('keeps voice style separate and retries only audio', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    const api = createApi('token');
    await api.previewVoice('v1', '你好', '轻声慢说');
    await api.messageSpeech('c1', 'm1');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: '你好', style_prompt: '轻声慢说' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/conversations/c1/messages/m1/speech');
    expect(fetchMock.mock.calls[1][1].method).toBe('POST');
  });

  it('submits provider keys only in request bodies and exposes no read-key method', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    const api = createApi('token');
    await api.addProvider({ name: 'demo', base_url: 'https://example.test/v1', api_key: 'private-canary' });
    await api.replaceProviderKey('p1', 'replacement-canary');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/providers');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).api_key).toBe('private-canary');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/providers/p1/key');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ api_key: 'replacement-canary' });
    expect(Object.keys(api)).not.toContain('getProviderKey');
  });

  it('deletes the exact provider, turn, history or conversation requested', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    const api = createApi('token');
    await api.deleteProvider('p1');
    await api.deleteTurn('c1', 'm1');
    await api.clearHistory('c1');
    await api.deleteConversation('c1');
    expect(fetchMock.mock.calls.map(call => [call[0], call[1].method])).toEqual([
      ['/api/v1/providers/p1', 'DELETE'],
      ['/api/v1/conversations/c1/messages/m1', 'DELETE'],
      ['/api/v1/conversations/c1/messages', 'DELETE'],
      ['/api/v1/conversations/c1', 'DELETE'],
    ]);
  });

  it('uses a same-origin URL and bearer header, not a query token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([])));
    vi.stubGlobal('fetch', fetchMock);
    await createApi('secret-token').providers();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/providers');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer secret-token');
  });

  it('creates only debug conversations from the testing UI', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'c1' })));
    vi.stubGlobal('fetch', fetchMock);
    await createApi('token').addConversation('我的会话');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      channel: 'debug', account_id: 'web', peer_id: '我的会话',
    });
  });

  it('sends an explicit unique external ID for message deduplication', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed' })));
    vi.stubGlobal('fetch', fetchMock);
    await createApi('token').send('c1', '你好', 'unique-id');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/debug/conversations/c1/messages');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: '你好', external_id: 'unique-id' });
  });

  it('explains an invalid management token in Chinese', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    await expect(request('wrong', '/providers')).rejects.toThrow('管理令牌不正确');
  });

  it('preserves a backend business error without leaking input details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'provider_key_missing', message: '中转站 API Key 未配置' },
    }), { status: 409 })));
    await expect(request('token', '/providers/p1/models')).rejects.toMatchObject({
      status: 409, code: 'provider_key_missing', message: '中转站 API Key 未配置',
    });
  });

  it('handles unavailable backend and non-JSON proxy responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(request('token', '/providers')).rejects.toThrow('无法连接后端');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('proxy error', { status: 500 })));
    await expect(request('token', '/providers')).rejects.toBeInstanceOf(ApiError);
  });

  it('warns about ambiguous results when a request is aborted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')));
    await expect(request('token', '/providers')).rejects.toThrow('请先刷新聊天记录');
  });
});
