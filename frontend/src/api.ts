import type { Capabilities, ChatMessage, Conversation, ConversationSettings, Provider, ProviderCreate,
  VoiceProfile, SpeechStatus, SpeechJob, SpeechFeedback, ChatStreamEvent } from './types';
import type { TaskRecord, TaskProject, TaskPlugin, TaskEvent, TaskDetail, TaskSubmission } from './types';
import { chatChannel, desktopHeaders } from './desktop';

export async function streamChat(token: string, id: string, text: string, externalId: string,
  onEvent: (event: ChatStreamEvent) => void, signal?: AbortSignal): Promise<ChatMessage> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout>;
  const armTimeout = () => { clearTimeout(timer); timer = setTimeout(abort, 75000); };
  armTimeout();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch('/api/v1/' + chatChannel + '/conversations/' + encodeURIComponent(id) + '/messages/stream', {
      method: 'POST', signal: controller.signal,
      headers: { ...desktopHeaders(), 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ text, external_id: externalId }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new ApiError(response.status === 401 ? '管理令牌不正确，请在连接设置中重新填写。'
        : payload?.error?.message || '无法开始流式回复，请检查后端。', response.status, payload?.error?.code);
    }
    reader = response.body?.getReader();
    if (!reader) throw new ApiError('浏览器未提供流式响应，请升级浏览器。', 502);
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      armTimeout();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const event = JSON.parse(data) as ChatStreamEvent;
        if (event.type === 'error') throw new ApiError(event.message, 502, event.code);
        onEvent(event);
        if (event.type === 'done') return event.message;
      }
      if (done) break;
    }
    throw new ApiError('回复连接中断，请刷新记录查看已保存的内容，避免重复发送。', 502);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError('回复连接已断开或超时，请刷新记录查看结果。', 408);
    throw new ApiError('流式回复连接异常，请刷新记录后重试。', 0);
  } finally {
    clearTimeout(timer!); signal?.removeEventListener('abort', abort);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

export async function request<T>(token: string, path: string, init: RequestInit = {},
  responseType: 'json' | 'blob' = 'json'): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75000);
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  try {
    const response = await fetch('/api/v1' + path, {
      ...init,
      headers: {
        ...desktopHeaders(),
        ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
        Authorization: 'Bearer ' + token,
      },
      signal: controller.signal,
    });
    if (response.ok && responseType === 'blob') return await response.blob() as T;
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = payload?.error;
      const message = response.status === 401 ? '管理令牌不正确，请在连接设置中重新填写。'
        : error?.message || (response.status === 422 ? '填写内容有误，请检查地址、模型名称等字段。'
        : '请求失败，请检查后端终端是否正常运行。');
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
    init.signal?.removeEventListener('abort', abort);
  }
}

export const createApi = (token: string) => ({
  taskRuntime: () => request<{ mode: string; state: string }>(token, '/task-runtime'),
  reportTask: (id: string) => request<{ text: string; source_seq: number; cached: boolean }>(token,
    '/tasks/' + encodeURIComponent(id) + '/report', { method: 'POST' }),
  taskPlugins: () => request<TaskPlugin[]>(token, '/plugins'),
  enableTaskPlugin: (id: string, enabled: boolean) => request<{ id: string; enabled: boolean }>(
    token, '/plugins/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ enabled }) }),
  taskProjects: () => request<TaskProject[]>(token, '/projects'),
  addTaskProject: (name: string, root: string) => request<TaskProject>(token, '/projects', {
    method: 'POST', body: JSON.stringify({ name, root }) }),
  tasks: (conversationId?: string, signal?: AbortSignal) => request<TaskRecord[]>(token,
    '/tasks' + (conversationId ? '?conversation_id=' + encodeURIComponent(conversationId) : ''), { signal }),
  createTask: (payload: TaskSubmission) => request<TaskRecord>(token, '/tasks', {
    method: 'POST', body: JSON.stringify(payload) }),
  taskDetail: (id: string, signal?: AbortSignal) => request<TaskDetail>(token,
    '/tasks/' + encodeURIComponent(id), { signal }),
  taskEvents: (id: string, after: number, signal?: AbortSignal) => request<TaskEvent[]>(token,
    '/tasks/' + encodeURIComponent(id) + '/events?after=' + after + '&limit=500', { signal }),
  cancelTask: (id: string) => request<TaskRecord>(token,
    '/tasks/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }),
  acknowledgeTask: (id: string) => request<TaskRecord>(token,
    '/tasks/' + encodeURIComponent(id) + '/acknowledge-interruption', {
      method: 'POST', body: JSON.stringify({ confirm_no_running_process: true }) }),
  sendStream: (id: string, text: string, externalId: string, onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal) => streamChat(token, id, text, externalId, onEvent, signal),
  speechStatus: () => request<SpeechStatus>(token, '/speech/status'),
  voices: () => request<VoiceProfile[]>(token, '/voices'),
  uploadVoice: (body: FormData) => request<VoiceProfile>(token, '/voices', { method: 'POST', body }),
  deleteVoice: (id: string) => request<{ deleted: boolean; affected_conversations: number }>(
    token, '/voices/' + encodeURIComponent(id), { method: 'DELETE' }),
  referenceAudio: (id: string) => request<Blob>(token, '/voices/' + encodeURIComponent(id) + '/reference', {}, 'blob'),
  previewVoice: (id: string, text: string, stylePrompt: string) => request<SpeechJob>(
    token, '/voices/' + encodeURIComponent(id) + '/previews', {
      method: 'POST', body: JSON.stringify({ text, style_prompt: stylePrompt }),
    }),
  speechJob: (id: string, signal?: AbortSignal) => request<SpeechJob>(token, '/speech/jobs/' + encodeURIComponent(id), { signal }),
  retrySpeechJob: (id: string, signal?: AbortSignal) => request<SpeechJob>(token, '/speech/jobs/' + encodeURIComponent(id) + '/retry', { method: 'POST', signal }),
  speechJobs: () => request<SpeechJob[]>(token, '/speech/jobs'),
  speechAudio: (id: string, signal?: AbortSignal) => request<Blob>(token, '/speech/jobs/' + encodeURIComponent(id) + '/audio', { signal }, 'blob'),
  generateFeedback: (conversationId: string, signal?: AbortSignal) => request<SpeechFeedback>(
    token, '/conversations/' + encodeURIComponent(conversationId) + '/speech-feedback', { method: 'POST', signal }),
  feedback: (conversationId: string, signal?: AbortSignal) => request<SpeechFeedback>(
    token, '/conversations/' + encodeURIComponent(conversationId) + '/speech-feedback', { signal }),
  deleteSpeechJob: (id: string) => request<{ deleted: boolean }>(
    token, '/speech/jobs/' + encodeURIComponent(id), { method: 'DELETE' }),
  messageSpeech: (conversationId: string, messageId: string) => request<SpeechJob>(
    token, '/conversations/' + encodeURIComponent(conversationId) + '/messages/'
      + encodeURIComponent(messageId) + '/speech', { method: 'POST' }),
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
    method: 'POST', body: JSON.stringify({ channel: chatChannel, account_id: chatChannel === 'desktop' ? 'desktop' : 'web', peer_id: name }),
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
    '/' + chatChannel + '/conversations/' + id + '/messages', {
      method: 'POST', body: JSON.stringify({ text, external_id: externalId }),
    }),
});

export type Api = ReturnType<typeof createApi>;
