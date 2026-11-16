import type { Capabilities, ChatMessage, Conversation, ConversationSettings, Provider, ProviderCreate } from './types';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

export async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75000);
  try {
    const response = await fetch('/api/v1' + path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
        Authorization: 'Bearer ' + token,
      },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = payload?.error;
      const message = response.status === 401 ? '管理令牌不正确，请在连接设置中重新填写。'
        : response.status === 422 ? '填写内容有误，请检查地址、模型名称等字段。'
        : error?.message || '请求失败，请检查后端终端是否正常运行。';
      throw new ApiError(message, response.status, error?.code);
    }
    if (payload === null) throw new ApiError('后端响应格式不正确，请确认连接的是菜菜 Bot 后端。', 502);
    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') {
      throw new ApiError('等待超时，结果可能已保存。请先刷新聊天记录，避免重复发送。', 408);
    }
    throw new ApiError('无法连接后端。请确认后端已在 8000 端口启动。', 0);
  } finally {
    clearTimeout(timer);
  }
}

export const createApi = (token: string) => ({
  capabilities: () => request<Capabilities>(token, '/capabilities'),
  providers: () => request<Provider[]>(token, '/providers'),
  addProvider: (payload: ProviderCreate) => request<Provider>(token, '/providers', {
    method: 'POST', body: JSON.stringify(payload),
  }),
  replaceProviderKey: (id: string, apiKey: string) => request<Provider>(token,
    '/providers/' + id + '/key', { method: 'PUT', body: JSON.stringify({ api_key: apiKey }) }),
  deleteProvider: (id: string) => request<{ deleted: boolean; affected_conversations: number }>(
    token, '/providers/' + id, { method: 'DELETE' }),
  models: (id: string) => request<{ models: string[] }>(token, '/providers/' + id + '/models'),
  conversations: () => request<Conversation[]>(token, '/conversations'),
  addConversation: (name: string) => request<Conversation>(token, '/conversations', {
    method: 'POST', body: JSON.stringify({ channel: 'debug', account_id: 'web', peer_id: name }),
  }),
  settings: (id: string, payload: ConversationSettings) => request<Conversation>(token,
    '/conversations/' + id + '/settings', { method: 'PUT', body: JSON.stringify(payload) }),
  history: (id: string) => request<ChatMessage[]>(token, '/conversations/' + id + '/messages'),
  clearHistory: (id: string) => request<{ deleted_count: number }>(token,
    '/conversations/' + id + '/messages', { method: 'DELETE' }),
  deleteTurn: (id: string, messageId: string) => request<{ deleted: boolean }>(token,
    '/conversations/' + id + '/messages/' + messageId, { method: 'DELETE' }),
  deleteConversation: (id: string) => request<{ deleted: boolean }>(token,
    '/conversations/' + id, { method: 'DELETE' }),
  send: (id: string, text: string, externalId: string) => request<ChatMessage>(token,
    '/debug/conversations/' + id + '/messages', {
      method: 'POST', body: JSON.stringify({ text, external_id: externalId }),
    }),
});

export type Api = ReturnType<typeof createApi>;
