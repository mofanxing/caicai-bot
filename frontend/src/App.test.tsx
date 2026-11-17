import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const preparePlayback = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('./speech', () => ({ MessageSpeech: () => null, prepareSpeechPlayback: preparePlayback,
  stopSpeechPlayback: () => {}, VoicesPage: () => <div>音色列表</div> }));

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  preparePlayback.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
    matches: false, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mockConnection() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const fetchMock = vi.fn().mockImplementation(async (url: string) => {
    await pending;
    return new Response(JSON.stringify(url.endsWith('/capabilities') ? { debug_mock_enabled: true } : []));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { release, fetchMock };
}

describe('workspace session restoration', () => {
  it('streams replies into the chat and remembers the automatic reading preference', async () => {
    sessionStorage.setItem('caicai.admin-token', 'saved-token');
    const conversation = { id: 'c1', channel: 'debug', account_id: 'web', peer_id: '测试',
      provider_id: null, model_id: null, reply_mode: 'both', voice_id: 'v1', voice_prompt: '', system_prompt: '' };
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let history: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/messages/stream')) return new Response(new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
      }));
      return new Response(JSON.stringify(url.endsWith('/capabilities') ? { debug_mock_enabled: true }
        : url.endsWith('/conversations') ? [conversation] : url.endsWith('/messages') ? history : []));
    }));
    render(<App />);
    const toggle = await screen.findByRole('switch', { name: '自动朗读新回复' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(localStorage.getItem('caicai.auto-read')).toBe('false');
    fireEvent.click(toggle);
    expect(localStorage.getItem('caicai.auto-read')).toBe('true');
    await waitFor(() => expect(screen.getByRole('button', { name: /发送/ })).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox', { name: '聊天内容' }), { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));
    expect(preparePlayback).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(controller).toBeDefined());
    const emit = (event: unknown) => controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'));
    await act(async () => {
      emit({ type: 'start', message_id: 'm1' });
      emit({ type: 'delta', text: '第一句话。' });
    });
    expect(await screen.findByText('第一句话。')).toBeTruthy();
    expect(screen.getByText('正在生成回复…')).toBeTruthy();
    const result = { id: 'm1', external_id: 'id', user_text: '你好', assistant_text: '第一句话。第二句话。',
      status: 'completed', speech_job_id: null, speech_job_ids: [] };
    history = [result];
    await act(async () => emit({ type: 'done', message: result }));
    expect(await screen.findByText('第一句话。第二句话。')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('正在生成回复…')).toBeNull());
  });
  it('shows the connection form immediately when there is no saved token', () => {
    const { fetchMock } = mockConnection();
    render(<App />);
    expect(screen.getByRole('heading', { name: '连接你的工作台' })).toBeTruthy();
    expect(screen.queryByText('正在恢复工作台连接…')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['chat', '聊天测试'], ['providers', '中转站管理'], ['voices', '音色与语音'],
    ['channels', '微信接入'], ['connection', '连接设置'],
  ])('restores %s without flashing the welcome page in StrictMode', async (page, title) => {
    sessionStorage.setItem('caicai.admin-token', 'saved-token');
    sessionStorage.setItem('caicai.page', page);
    const { release } = mockConnection();
    render(<StrictMode><App /></StrictMode>);
    expect(screen.getByText('正在恢复工作台连接…')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '连接你的工作台' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull();
    await act(async () => release());
    expect(await screen.findByRole('heading', { name: title, level: 1 })).toBeTruthy();
    expect(screen.queryByText('正在恢复工作台连接…')).toBeNull();
    expect(screen.queryByRole('heading', { name: '连接你的工作台' })).toBeNull();
    expect(sessionStorage.getItem('caicai.page')).toBe(page);
  });

  it('returns to the connection form on failure and allows a retry', async () => {
    sessionStorage.setItem('caicai.admin-token', 'saved-token');
    sessionStorage.setItem('caicai.page', 'channels');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    render(<App />);
    expect(await screen.findByRole('heading', { name: '连接你的工作台' })).toBeTruthy();
    expect(screen.getByText('管理令牌不正确，请在连接设置中重新填写。')).toBeTruthy();
    expect(screen.queryByText('正在恢复工作台连接…')).toBeNull();
    const { release } = mockConnection();
    release();
    fireEvent.click(screen.getByRole('button', { name: /连接后端/ }));
    expect(await screen.findByRole('heading', { name: '微信接入', level: 1 })).toBeTruthy();
  });

  it('saves navigation and restores it after remounting', async () => {
    sessionStorage.setItem('caicai.admin-token', 'saved-token');
    const { release } = mockConnection();
    release();
    const view = render(<App />);
    await screen.findByRole('navigation', { name: '主导航' });
    fireEvent.click(screen.getByRole('button', { name: '微信接入' }));
    await waitFor(() => expect(sessionStorage.getItem('caicai.page')).toBe('channels'));
    view.unmount();
    render(<App />);
    expect(screen.queryByRole('heading', { name: '连接你的工作台' })).toBeNull();
    expect(await screen.findByRole('heading', { name: '微信接入', level: 1 })).toBeTruthy();
  });

  it('falls back to chat for an invalid saved page', async () => {
    sessionStorage.setItem('caicai.admin-token', 'saved-token');
    sessionStorage.setItem('caicai.page', 'unknown');
    const { release } = mockConnection();
    release();
    render(<App />);
    expect(await screen.findByRole('heading', { name: '聊天测试', level: 1 })).toBeTruthy();
    expect(sessionStorage.getItem('caicai.page')).toBe('chat');
  });

  it('clears the saved session and page when disconnected', async () => {
    sessionStorage.setItem('caicai.admin-token', 'saved-token');
    sessionStorage.setItem('caicai.page', 'connection');
    const { release } = mockConnection();
    release();
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /断开并清除令牌/ }));
    expect(screen.getByRole('heading', { name: '连接你的工作台' })).toBeTruthy();
    expect(sessionStorage.getItem('caicai.admin-token')).toBeNull();
    expect(sessionStorage.getItem('caicai.page')).toBeNull();
  });
});
