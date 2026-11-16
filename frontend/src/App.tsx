import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, App as AntApp, AutoComplete, Avatar, Badge, Button, Card, Collapse,
  Dropdown, Empty, Form, Input, Modal, Select, Skeleton, Spin, Tag, Tooltip,
} from 'antd';
import {
  ArrowRightOutlined, AudioOutlined, CheckCircleFilled, CheckOutlined, CloudServerOutlined,
  CommentOutlined, DeleteOutlined, DisconnectOutlined, EditOutlined, EllipsisOutlined,
  ExperimentOutlined, KeyOutlined, LinkOutlined,
  PlusOutlined, ReloadOutlined, SafetyCertificateOutlined, SendOutlined,
  SettingOutlined, SlidersOutlined, WechatOutlined,
} from '@ant-design/icons';
import { createApi, type Api } from './api';
import type { Capabilities, ChatMessage, Conversation, Provider, ProviderCreate, VoiceProfile } from './types';
import { MessageSpeech, VoicesPage } from './speech';

type Page = 'chat' | 'providers' | 'voices' | 'channels' | 'connection';
const TOKEN_STORAGE = 'caicai.admin-token';
const CONVERSATION_STORAGE = 'caicai.conversation';
const PAGE_STORAGE = 'caicai.page';
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试。';

function Brand({ small = false }: { small?: boolean }) {
  return <div className={'brand ' + (small ? 'brand-small' : '')}>
    <img src="/favicon.svg" alt="" /><div>菜菜 <span>Bot</span><small>你的 AI 聊天工作台</small></div>
  </div>;
}

function ConnectionForm({ initialToken, connecting, onConnect }: {
  initialToken: string; connecting: boolean; onConnect: (token: string) => void;
}) {
  return <Form layout="vertical" initialValues={{ token: initialToken }}
    onFinish={(values) => onConnect(values.token.trim())} requiredMark={false} disabled={connecting}>
    <Form.Item label="管理令牌" name="token" rules={[{ required: true, whitespace: true, message: '请填写管理令牌' }]}>
      <Input.Password prefix={<KeyOutlined />} placeholder="粘贴 backend/.env 中 ADMIN_TOKEN 的值"
        size="large" autoComplete="off" />
    </Form.Item>
    <div className="field-help">打开 <code>backend/.env</code>，复制 <code>ADMIN_TOKEN=</code> 后面的内容，不需要添加 Bearer。</div>
    <Button type="primary" size="large" htmlType="submit" loading={connecting} block icon={<LinkOutlined />}>
      连接后端
    </Button>
    <p className="privacy-note"><SafetyCertificateOutlined /> 令牌仅暂存在当前浏览器标签页，断开连接后清除。</p>
  </Form>;
}

function ModelSettings({ api, conversation, providers, voices, capabilities, onSaved, disabled }: {
  api: Api; conversation: Conversation; providers: Provider[]; capabilities: Capabilities;
  voices: VoiceProfile[];
  onSaved: (value: Conversation) => void; disabled: boolean;
}) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modelError, setModelError] = useState('');
  const [dirty, setDirty] = useState(false);
  const selectedProvider = Form.useWatch('provider_id', form);
  const replyMode = Form.useWatch('reply_mode', form);
  const modelRequest = useRef(0);

  useEffect(() => {
    form.setFieldsValue({ provider_id: conversation.provider_id || '',
      model_id: conversation.model_id || '', system_prompt: conversation.system_prompt,
      reply_mode: conversation.reply_mode, voice_id: conversation.voice_id || undefined,
      voice_prompt: conversation.voice_prompt || '' });
    setDirty(false);
  }, [conversation, form]);

  useEffect(() => {
    const requestId = ++modelRequest.current;
    setModels([]); setModelError(''); setLoading(false);
    return () => { if (requestId === modelRequest.current) modelRequest.current++; };
  }, [selectedProvider]);

  async function fetchModels() {
    if (!selectedProvider) return;
    const requestId = ++modelRequest.current;
    setLoading(true); setModelError('');
    try {
      const data = await api.models(selectedProvider);
      if (requestId === modelRequest.current) {
        setModels(data.models);
        if (!data.models.length) setModelError('站点返回了空列表，也可以手动填写模型 ID。');
        else message.success('已获取 ' + data.models.length + ' 个模型');
      }
    } catch (error) {
      if (requestId === modelRequest.current) setModelError(errorText(error) + ' 也可以手动填写模型 ID。');
    } finally { if (requestId === modelRequest.current) setLoading(false); }
  }

  async function save(values: { provider_id: string; model_id: string; system_prompt: string;
    reply_mode: 'text' | 'voice' | 'both'; voice_id?: string; voice_prompt?: string }) {
    setSaving(true);
    try {
      const updated = await api.settings(conversation.id, {
        provider_id: values.provider_id || null,
        model_id: values.provider_id ? values.model_id.trim() : null,
        system_prompt: values.system_prompt, reply_mode: values.reply_mode,
        voice_id: values.voice_id || null, voice_prompt: values.voice_prompt || '',
      });
      onSaved(updated); setDirty(false); message.success('聊天设置已保存');
    } catch (error) { message.error(errorText(error)); }
    finally { setSaving(false); }
  }

  return <Card className="settings-card" title={<><SlidersOutlined /> 聊天设置</>}>
    <p className="muted compact">为当前会话选择模型和角色。</p>
    <Form form={form} layout="vertical" onFinish={save} onValuesChange={() => setDirty(true)} requiredMark={false}>
      <Form.Item name="provider_id" label="模型来源">
        <Select disabled={disabled || saving} options={[
          { value: '', label: '本地模拟 · 无需 API Key', disabled: !capabilities.debug_mock_enabled },
          ...providers.map(p => ({ value: p.id, label: p.name })),
        ]} onChange={() => { form.setFieldValue('model_id', ''); setModels([]); }} />
      </Form.Item>
      {selectedProvider ? <>
        <Form.Item label={<div className="model-label">聊天模型 <Button type="link" size="small"
          onClick={fetchModels} loading={loading} disabled={disabled}>获取列表</Button></div>}
          name="model_id" rules={[{ required: true, whitespace: true, message: '请选择或填写模型 ID' }]}>
          <AutoComplete options={models.map(value => ({ value }))} placeholder="获取列表，或手动输入模型 ID"
            disabled={disabled || saving} filterOption={(input, option) =>
              String(option?.value || '').toLowerCase().includes(input.toLowerCase())} />
        </Form.Item>
        {modelError && <Alert type="warning" message={modelError} className="inline-alert" />}
      </> : <div className="mock-note"><ExperimentOutlined /> {capabilities.debug_mock_enabled
        ? '模拟回复用于验证流程，不会调用真实模型或产生模型费用。'
        : '后端未开启模拟回复，请选择一个中转站。'}</div>}
      <Form.Item name="system_prompt" label="角色设定">
        <Input.TextArea rows={4} maxLength={16000} disabled={disabled || saving}
          placeholder="例如：你是菜菜，用简短、自然的语言与我聊天。" />
      </Form.Item>
      <Form.Item name="reply_mode" label="回复方式"><Select disabled={disabled || saving} options={[
        { value: 'text', label: '文字（可手动朗读）' }, { value: 'both', label: '文字 + 本地语音' },
      ]} /></Form.Item>
      <Form.Item name="voice_id" label="朗读音色" rules={replyMode !== 'text' ? [{ required: true, message: '请先添加并选择音色' }] : []}>
        <Select allowClear disabled={disabled || saving} placeholder="在音色与语音页面上传录音"
          options={voices.map(voice => ({ value: voice.id, label: voice.name }))} />
      </Form.Item>
      <Form.Item name="voice_prompt" label="语音表达提示词"><Input.TextArea rows={2} maxLength={500}
        disabled={disabled || saving} placeholder="留空跟随音色默认语气，例如：温柔自然，语速稍慢" /></Form.Item>
      <p className="muted compact">语气控制发声，角色设定控制回复内容。语音后台生成，失败时保留文字；单次最多 600 字。</p>
      {dirty && <p className="unsaved">有未保存的修改，保存后新消息才会使用。</p>}
      <Button htmlType="submit" type="primary" block loading={saving} disabled={disabled}>保存聊天设置</Button>
    </Form>
  </Card>;
}

function ProvidersPage({ api, providers, onAdded, onChanged, onRemoved, disabled }: {
  api: Api; providers: Provider[]; onAdded: (p: Provider) => void;
  onChanged: (p: Provider) => void; onRemoved: (id: string) => void; disabled: boolean;
}) {
  const { message, modal } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [form] = Form.useForm();
  const [keyForm] = Form.useForm();
  const [keyProvider, setKeyProvider] = useState<Provider | null>(null);
  const [keySaving, setKeySaving] = useState(false);

  function closeCreate() {
    if (saving) return;
    form.resetFields(); setOpen(false);
  }

  function closeKey() {
    if (keySaving) return;
    keyForm.resetFields(); setKeyProvider(null);
  }

  async function replaceKey(values: { api_key: string }) {
    if (!keyProvider) return;
    setKeySaving(true);
    try {
      const updated = await api.replaceProviderKey(keyProvider.id, values.api_key.trim());
      onChanged(updated); setKeyProvider(null); message.success('新密钥已加密保存，即刻生效');
      setResults(previous => { const next = { ...previous }; delete next[updated.id]; return next; });
    } catch (error) { message.error(errorText(error)); }
    finally { keyForm.resetFields(); setKeySaving(false); }
  }

  function removeProvider(provider: Provider) {
    modal.confirm({ title: '删除中转站「' + provider.name + '」？',
      content: '将删除该站点和数据库中的加密密钥，并解除相关会话的模型绑定。聊天记录保留；删除后无法恢复。旧环境变量不会自动删除。',
      okText: '删除中转站', cancelText: '取消', okButtonProps: { danger: true },
      async onOk() {
        try {
          const result = await api.deleteProvider(provider.id);
          onRemoved(provider.id);
          message.success('中转站已删除，已解除 ' + result.affected_conversations + ' 个会话绑定');
        } catch (error) { message.error(errorText(error)); throw error; }
      },
    });
  }

  async function addProvider(values: ProviderCreate) {
    setSaving(true);
    try {
      const created = await api.addProvider({ name: values.name.trim(), base_url: values.base_url.trim(),
        api_key: values.api_key.trim() });
      onAdded(created); setOpen(false); form.resetFields(); message.success('中转站已添加，现在可以测试连接');
    } catch (error) { message.error(errorText(error)); }
    finally { form.resetFields(['api_key']); setSaving(false); }
  }

  async function testProvider(provider: Provider) {
    setTestingId(provider.id);
    try {
      const data = await api.models(provider.id);
      setResults(previous => ({ ...previous, [provider.id]: { ok: true, text: '已获取 ' + data.models.length + ' 个模型' } }));
    } catch (error) {
      setResults(previous => ({ ...previous, [provider.id]: { ok: false, text: errorText(error) } }));
    } finally { setTestingId(null); }
  }

  return <div className="page-body providers-page">
    <div className="section-heading"><div><h2>连接你的模型世界</h2><p>添加兼容 OpenAI 接口的中转站，按会话自由选择模型。</p></div>
      <Button type="primary" icon={<PlusOutlined />} size="large" disabled={disabled} onClick={() => setOpen(true)}>添加中转站</Button></div>
    <div className="info-strip"><SafetyCertificateOutlined /><span>直接填写 API Key，后端加密保存。页面不提供查看或导出密钥，保存后只显示配置状态。</span></div>
    <div className="provider-grid">
      {providers.map((provider, index) => <Card className="provider-card" key={provider.id}>
        <div className="provider-card-heading"><Avatar shape="square" size={46} className="provider-avatar"><CloudServerOutlined /></Avatar>
          <span className="eyebrow">PROVIDER / {String(index + 1).padStart(2, '0')}</span></div>
        <h3>{provider.name}</h3><p className="provider-url">{provider.base_url}</p>
        <div className="provider-key"><SafetyCertificateOutlined /><span>{provider.has_api_key
          ? provider.key_source === 'encrypted' ? '密钥已加密保存' : '已配置 · 兼容旧环境变量' : '尚未配置密钥'}</span></div>
        {results[provider.id] && <Alert showIcon type={results[provider.id].ok ? 'success' : 'error'}
          message={results[provider.id].text} className="inline-alert" />}
        <Button block icon={<LinkOutlined />} loading={testingId === provider.id}
          disabled={disabled || (testingId !== null && testingId !== provider.id)} onClick={() => testProvider(provider)}>测试连接 · 获取模型</Button>
        <div className="provider-actions"><Button type="text" icon={<EditOutlined />} disabled={disabled || testingId !== null}
          onClick={() => { keyForm.resetFields(); setKeyProvider(provider); }}>替换密钥</Button>
          <Button type="text" danger icon={<DeleteOutlined />} disabled={disabled || testingId !== null}
            onClick={() => removeProvider(provider)}>删除站点</Button></div>
      </Card>)}
      <button className="add-provider-card" disabled={disabled} onClick={() => setOpen(true)}><span><PlusOutlined /></span>
        <strong>添加一个中转站</strong><small>填写名称和地址，即可开始连接</small></button>
    </div>
    <Card className="guide-card" title="第一次配置？跟着这三步来">
      <div className="guide-grid"><div><b>01</b><h4>填写站点地址</h4><p>通常以 /v1 结尾，不要填写 /chat/completions。</p></div>
        <div><b>02</b><h4>直接填写 API Key</h4><p>在添加站点时填写，后端加密保存，无需修改文件或重启。</p></div>
        <div><b>03</b><h4>选择模型，开始聊天</h4><p>测试连接后，到聊天测试里选择站点与模型并保存。</p></div></div>
    </Card>
    <Modal title="添加中转站" open={open} onCancel={closeCreate} footer={null}
      maskClosable={!saving} closable={!saving}>
      <p className="muted">连接一个兼容 OpenAI 接口的模型服务。</p>
      <Form form={form} layout="vertical" onFinish={addProvider} requiredMark={false} disabled={saving}>
        <Form.Item name="name" label="站点名称" rules={[{ required: true, whitespace: true, message: '请填写站点名称' }]}>
          <Input placeholder="例如：我的中转站" maxLength={100} /></Form.Item>
        <Form.Item name="base_url" label="站点地址（Base URL）" rules={[
          { required: true, message: '请填写站点地址' }, { type: 'url', message: '请输入完整的 http:// 或 https:// 地址' },
        ]} extra="外部站点必须使用 HTTPS，通常填写到 /v1；本机测试可使用 HTTP。">
          <Input placeholder="https://你的站点地址/v1" /></Form.Item>
        <Form.Item name="api_key" label="API Key" preserve={false} rules={[
          { required: true, whitespace: true, message: '请填写真实 API Key' },
        ]} extra="直接粘贴站点提供的密钥，不需要填写变量名或 Bearer。保存后不回显。">
          <Input.Password autoComplete="off" visibilityToggle={false} maxLength={4096} placeholder="粘贴 API Key" /></Form.Item>
        <Alert type="info" showIcon message="只写入，不回读" description="密钥仅在保存时发送至后端，加密后存入数据库。请勿在聊天内容中粘贴密钥，也不要把管理令牌分享给其他人。" />
        <Button type="primary" htmlType="submit" block size="large" loading={saving} className="modal-submit">添加中转站</Button>
      </Form>
    </Modal>
    <Modal title={'替换密钥' + (keyProvider ? ' · ' + keyProvider.name : '')} open={!!keyProvider}
      onCancel={closeKey} footer={null} closable={!keySaving} maskClosable={!keySaving}>
      <p className="muted">无法查看原密钥。填写后将覆盖该站点当前的密钥来源，保存后立即生效。</p>
      <Form form={keyForm} layout="vertical" onFinish={replaceKey} disabled={keySaving}>
        <Form.Item name="api_key" label="新的 API Key" preserve={false}
          rules={[{ required: true, whitespace: true, message: '请填写新的 API Key' }]}>
          <Input.Password autoComplete="off" visibilityToggle={false} maxLength={4096} placeholder="粘贴新的 API Key" />
        </Form.Item>
        <Alert type="info" showIcon message="站点地址不会随密钥替换而改变" description="为避免已有密钥被发送到其他站点，修改地址需要删除站点后重新添加。" />
        <Button type="primary" htmlType="submit" block loading={keySaving} className="modal-submit">加密保存新密钥</Button>
      </Form>
    </Modal>
  </div>;
}

export default function App() {
  const { message, modal } = AntApp.useApp();
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_STORAGE) || '');
  const [restoring, setRestoring] = useState(() => !!token);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [page, setPage] = useState<Page>(() => {
    const saved = sessionStorage.getItem(PAGE_STORAGE);
    return saved === 'providers' || saved === 'voices' || saved === 'channels' || saved === 'connection'
      ? saved : 'chat';
  });
  const [providers, setProviders] = useState<Provider[]>([]);
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [activeId, setActiveId] = useState('');
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [draft, setDraft] = useState('');
  const [pendingText, setPendingText] = useState('');
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatName, setNewChatName] = useState('');
  const historyRequest = useRef(0);
  const connectionRequest = useRef(0);
  const sendLock = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const api = useMemo(() => createApi(token), [token]);
  const debugConversations = conversations.filter(c => c.channel === 'debug');
  const active = debugConversations.find(c => c.id === activeId);
  const activeProvider = providers.find(p => p.id === active?.provider_id);
  const busy = sending || deleting;

  function providerRemoved(id: string) {
    setProviders(previous => previous.filter(provider => provider.id !== id));
    setConversations(previous => previous.map(conversation => conversation.provider_id === id
      ? { ...conversation, provider_id: null, model_id: null } : conversation));
  }

  function confirmDelete(kind: 'turn' | 'history' | 'conversation', turnId?: string) {
    if (!active || busy) return;
    const selected = active;
    const labels = {
      turn: ['删除这一轮对话？', '该条提问及回答会一起删除，也不再用于后续聊天上下文。'],
      history: ['清空当前聊天记录？', '将删除该测试会话的全部提问与回答，保留会话及模型设置，并重置聊天上下文。'],
      conversation: ['删除测试会话「' + selected.peer_id + '」？', '将删除该测试会话、设置及全部聊天记录。'],
    };
    modal.confirm({ title: labels[kind][0], content: labels[kind][1] + ' 此操作无法撤销。',
      okText: kind === 'history' ? '清空记录' : '确认删除', cancelText: '取消',
      okButtonProps: { danger: true },
      async onOk() {
        setDeleting(true); sendLock.current = true; historyRequest.current++;
        try {
          if (kind === 'conversation') {
            await api.deleteConversation(selected.id);
            const remaining = debugConversations.filter(conversation => conversation.id !== selected.id);
            setConversations(previous => previous.filter(conversation => conversation.id !== selected.id));
            sessionStorage.removeItem(CONVERSATION_STORAGE); setHistory([]); setDraft('');
            setActiveId(remaining[0]?.id || '');
            message.success('测试会话已删除');
          } else if (kind === 'history') {
            await api.clearHistory(selected.id); setHistory([]); setHistoryError('');
            message.success('聊天记录已清空，下一条消息将重新开始上下文');
          } else if (turnId) {
            await api.deleteTurn(selected.id, turnId);
            setHistory(previous => previous.filter(turn => turn.id !== turnId));
            message.success('这一轮对话已删除');
          }
        } catch (error) { message.error(errorText(error)); throw error; }
        finally { setDeleting(false); setHistoryLoading(false); sendLock.current = false; }
      },
    });
  }

  async function connect(value: string) {
    const generation = ++connectionRequest.current;
    setConnecting(true); setConnectionError('');
    try {
      const nextApi = createApi(value);
      const [caps, sites, chats, voiceProfiles] = await Promise.all([
        nextApi.capabilities(), nextApi.providers(), nextApi.conversations(), nextApi.voices(),
      ]);
      if (generation !== connectionRequest.current) return;
      setToken(value); sessionStorage.setItem(TOKEN_STORAGE, value);
      setCapabilities(caps); setProviders(sites); setConversations(chats);
      setVoices(voiceProfiles);
      const saved = sessionStorage.getItem(CONVERSATION_STORAGE);
      setActiveId(chats.find(c => c.channel === 'debug' && c.id === saved)?.id
        || chats.find(c => c.channel === 'debug')?.id || '');
      setConnected(true);
    } catch (error) {
      if (generation === connectionRequest.current) { setConnectionError(errorText(error)); setConnected(false); }
    } finally {
      if (generation === connectionRequest.current) { setConnecting(false); setRestoring(false); }
    }
  }

  useEffect(() => {
    const saved = sessionStorage.getItem(TOKEN_STORAGE);
    if (saved) void connect(saved);
    return () => { connectionRequest.current++; };
  }, []);

  useEffect(() => {
    if (connected) sessionStorage.setItem(PAGE_STORAGE, page);
  }, [connected, page]);

  async function loadHistory(id: string) {
    const requestId = ++historyRequest.current;
    setHistoryLoading(true); setHistoryError('');
    try {
      const data = await api.history(id);
      if (requestId === historyRequest.current) setHistory([...data].reverse());
    } catch (error) {
      if (requestId === historyRequest.current) setHistoryError(errorText(error));
    } finally { if (requestId === historyRequest.current) setHistoryLoading(false); }
  }

  useEffect(() => {
    setHistory([]); setHistoryError(''); setDraft('');
    if (connected && activeId) {
      sessionStorage.setItem(CONVERSATION_STORAGE, activeId);
      void loadHistory(activeId);
    }
    return () => { historyRequest.current++; };
  }, [activeId, connected, api]);

  useEffect(() => {
    const container = messagesRef.current;
    if (container) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, [history, pendingText]);

  function disconnect() {
    connectionRequest.current++; historyRequest.current++;
    sessionStorage.removeItem(TOKEN_STORAGE); sessionStorage.removeItem(CONVERSATION_STORAGE);
    sessionStorage.removeItem(PAGE_STORAGE);
    setRestoring(false); setConnecting(false); setPage('chat');
    setConnected(false); setToken(''); setHistory([]); setConversations([]); setProviders([]);
    setVoices([]);
    setCapabilities(null); setActiveId(''); setConnectionError('');
  }

  async function createConversation() {
    const name = newChatName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await api.addConversation(name);
      setConversations(previous => [...previous, created]); setActiveId(created.id);
      setNewChatOpen(false); setNewChatName(''); message.success('会话已创建');
    } catch (error) { message.error(errorText(error)); }
    finally { setCreating(false); }
  }

  async function send() {
    if (!active || !draft.trim() || sendLock.current || busy || historyLoading || historyError) return;
    if (!active.provider_id && !capabilities?.debug_mock_enabled) {
      message.warning('请先在右侧选择中转站和模型，保存后再发送。'); return;
    }
    const text = draft.trim();
    sendLock.current = true; setSending(true); setPendingText(text); setDraft(''); setHistoryError('');
    try {
      const result = await api.send(active.id, text, crypto.randomUUID());
      if (result.status !== 'completed' && result.status !== 'sent') {
        message.warning('消息状态：' + result.status + '，请查看记录后再决定是否重发。');
      }
    } catch (error) { message.error(errorText(error), 7); }
    finally {
      await loadHistory(active.id);
      setPendingText(''); setSending(false); sendLock.current = false;
    }
  }

  async function refreshVoices() {
    const [nextVoices, nextConversations] = await Promise.all([api.voices(), api.conversations()]);
    setVoices(nextVoices); setConversations(nextConversations);
  }

  const pageTitles: Record<Page, [string, string]> = {
    chat: ['聊天测试', '调好角色和音色，让每一句回应更亲近。'],
    providers: ['中转站管理', '一个工作台，连接不同的模型服务。'],
    voices: ['音色与语音', '熟悉的声音，在你的电脑上生成。'],
    channels: ['微信接入', '微信能力后续接入，先在本地体验菜菜。'],
    connection: ['连接设置', '管理工作台与本地后端的连接。'],
  };

  if (restoring) return <div className="session-loading" role="status" aria-live="polite" aria-busy="true">
    <Spin size="large" /><p>正在恢复工作台连接…</p>
  </div>;

  if (!connected) return <div className="welcome-screen"><div className="welcome-art">
    <Brand /><div className="welcome-copy"><span className="eyebrow">A LITTLE AI, A LITTLE COMPANY.</span>
      <h1>让每一句回应，<br />都更像你想要的。</h1><p>连接喜欢的模型，设定专属的角色。<br />从一句「你好」开始，慢慢认识你的菜菜。</p>
      <div className="welcome-feature"><span><CheckCircleFilled /> 多模型接入</span><span><CheckCircleFilled /> 自定义角色</span><span><CheckCircleFilled /> 本地聊天测试</span></div>
    </div><div className="welcome-bottom"><span className="orbit-dot" /> CAICAI BOT / LOCAL WORKSPACE</div>
  </div><div className="welcome-form"><div className="login-box"><span className="pill">欢迎来到菜菜 Bot</span>
    <h2>连接你的工作台</h2><p className="muted">确认后端已启动，填写一次令牌，即可开始。</p>
    {connectionError && <Alert type="error" showIcon message={connectionError} className="inline-alert" />}
    <ConnectionForm initialToken={token} connecting={connecting} onConnect={connect} />
    <Collapse ghost items={[{ key: 'help', label: '还没启动后端？查看操作步骤', children: <>
      <p>在项目根目录的终端执行：</p><pre>cd backend<br />source .venv/bin/activate<br />uvicorn app.main:create_app --factory --reload</pre>
      <p>保持终端运行，再点击「连接后端」。</p></> }]} />
  </div></div></div>;

  return <div className="workspace"><aside className="sidebar"><Brand />
    <div className="sidebar-label">工作空间</div><nav aria-label="主导航">
      {([
        ['chat', <CommentOutlined />, '聊天测试'], ['providers', <CloudServerOutlined />, '中转站管理'],
        ['voices', <AudioOutlined />, '音色与语音'], ['channels', <WechatOutlined />, '微信接入'], ['connection', <SettingOutlined />, '连接设置'],
      ] as const).map(([key, icon, label]) => <button key={key} className={'nav-item ' + (page === key ? 'selected' : '')}
        aria-label={label} title={label} onClick={() => setPage(key)}>{icon}<span>{label}</span>{page === key && <i />}</button>)}
    </nav><div className="sidebar-note"><span className="sidebar-note-icon"><ExperimentOutlined /></span>
      <strong>让回应有熟悉的声音</strong><p>上传参考录音，在本机生成菜菜的专属声音。</p><button onClick={() => setPage('voices')}>去音色与语音 <ArrowRightOutlined /></button></div>
    <div className="sidebar-footer"><Badge status="success" text="本地后端已连接" /><span>开发工作台 · v0.1</span></div>
  </aside><main className="main-content"><header className="topbar"><div><div className="breadcrumb">工作空间 <span>/</span> {pageTitles[page][0]}</div>
    <h1>{pageTitles[page][0]}</h1><p>{pageTitles[page][1]}</p></div><div className="topbar-right"><span className="local-badge"><span /> 本地开发</span>
      <Avatar style={{ background: '#e4eadf', color: '#45614d' }}>我</Avatar></div></header>

    {page === 'providers' && <ProvidersPage api={api} providers={providers} disabled={busy}
      onAdded={p => setProviders(previous => [...previous, p])}
      onChanged={updated => setProviders(previous => previous.map(p => p.id === updated.id ? updated : p))}
      onRemoved={providerRemoved} />}

    {page === 'chat' && <div className="chat-page"><div className="chat-toolbar"><div className="conversation-select">
      <Select aria-label="选择测试会话" value={activeId || undefined} placeholder="创建你的第一个会话" disabled={busy}
        onChange={setActiveId} options={debugConversations.map(c => ({ value: c.id, label: c.peer_id }))} />
      <Button icon={<PlusOutlined />} disabled={busy} onClick={() => { setNewChatName('测试会话 ' + (debugConversations.length + 1)); setNewChatOpen(true); }}>新建会话</Button>
    </div><span className="toolbar-caption"><SafetyCertificateOutlined /> 聊天记录保存在本地后端</span></div>
    <div className="chat-grid"><section className="chat-panel" aria-label="聊天消息">
      <div className="chat-panel-header"><div><Avatar src="/favicon.svg" shape="square" size={40} /><div><strong>菜菜</strong>
        <span>{active?.provider_id ? activeProvider?.name || '中转站模型' : '本地模拟模式'}{active?.model_id ? ' / ' + active.model_id : ''}</span></div></div>
        <div className="chat-header-actions"><Tooltip title="刷新聊天记录"><Button type="text" aria-label="刷新聊天记录" icon={<ReloadOutlined />} disabled={!active || busy} loading={historyLoading}
          onClick={() => active && loadHistory(active.id)} /></Tooltip>
        <Dropdown trigger={['click']} menu={{ items: [
          { key: 'history', label: '清空聊天记录', icon: <DeleteOutlined />, danger: true },
          { key: 'conversation', label: '删除测试会话', icon: <DeleteOutlined />, danger: true },
        ], onClick: ({ key }) => confirmDelete(key as 'history' | 'conversation') }} disabled={!active || busy || historyLoading}>
          <Button type="text" aria-label="会话更多操作" icon={<EllipsisOutlined />} disabled={!active || busy || historyLoading} />
        </Dropdown></div></div>
      <div className="chat-messages" aria-live="polite" ref={messagesRef}>
        {historyError && <Alert type="error" showIcon message={historyError} description="请点击右上角刷新记录，成功后再继续发送。" />}
        {historyLoading && !sending ? <Skeleton active paragraph={{ rows: 4 }} /> : <>
          {!history.length && !sending && <div className="chat-empty"><div className="bot-illustration"><img src="/favicon.svg" alt="菜菜" /><span className="spark spark-one">✦</span><span className="spark spark-two">✧</span></div>
            <span className="eyebrow">MEET YOUR LITTLE COMPANION</span><h2>你好呀，我是菜菜。</h2>
            <p>{active ? '选好模型和角色，就从你想说的第一句话开始吧。' : '先创建一个测试会话，就可以在这里和我聊天。'}</p>
            {active ? <div className="suggestions">{['介绍一下你自己', '帮我规划今天的学习', '给我讲个轻松的小故事'].map(text =>
              <button key={text} onClick={() => setDraft(text)}>{text}<ArrowRightOutlined /></button>)}</div>
              : <Button type="primary" icon={<PlusOutlined />} onClick={() => { setNewChatName('我的第一个会话'); setNewChatOpen(true); }}>创建第一个会话</Button>}
          </div>}
          {history.map(turn => <div className="chat-turn" key={turn.id}><div className="message-row user"><div className="message-content"><span>我</span><div className="bubble">{turn.user_text}</div></div><Avatar>我</Avatar></div>
            {turn.assistant_text && <div className="message-row assistant"><Avatar src="/favicon.svg" shape="square" /><div className="message-content"><span>菜菜</span><div className="bubble">{turn.assistant_text}</div>
              <MessageSpeech api={api} conversationId={activeId} messageId={turn.id} initialJobId={turn.speech_job_id || null} canGenerate={!!active?.voice_id && !busy} /></div></div>}
            {!['completed', 'sent'].includes(turn.status) && <div className="message-status"><Tag color={turn.status === 'failed' ? 'error' : 'warning'}>{({ failed: '处理失败', delivery_unknown: '投递结果待核查', processing: '处理中，请刷新记录', sending: '发送结果待确认' } as Record<string, string>)[turn.status] || turn.status}</Tag></div>}
            <div className="turn-actions"><Button type="text" size="small" danger icon={<DeleteOutlined />}
              aria-label="删除这一轮对话" disabled={busy || historyLoading} onClick={() => confirmDelete('turn', turn.id)}>删除这轮对话</Button></div>
          </div>)}
          {sending && <><div className="message-row user"><div className="message-content"><span>我</span><div className="bubble">{pendingText}</div></div><Avatar>我</Avatar></div>
            <div className="message-row assistant"><Avatar src="/favicon.svg" shape="square" /><div className="typing-bubble"><span /><span /><span /><small>菜菜正在想一想</small></div></div></>}
        </>}
      </div><div className="composer"><Input.TextArea aria-label="聊天内容" value={draft} onChange={event => setDraft(event.target.value)}
        disabled={!active || busy} placeholder={active ? '和菜菜聊点什么…' : '创建会话后开始聊天'} autoSize={{ minRows: 2, maxRows: 6 }} maxLength={16000}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        <div className="composer-footer"><span>Enter 发送 · Shift + Enter 换行</span><Button type="primary" icon={<SendOutlined />} loading={sending}
          disabled={!active || !draft.trim() || busy || historyLoading || !!historyError} onClick={send}>发送</Button></div></div>
      <div className="chat-disclaimer">{active?.provider_id ? '当前使用中转站模型，调用可能产生费用。' : '模拟模式只验证聊天流程，不代表真实 AI 回答。'} 当前为网页测试，消息不会发送到微信。</div>
    </section><aside className="chat-settings">{active && capabilities ? <ModelSettings key={active.id} api={api} conversation={active}
      providers={providers} voices={voices} capabilities={capabilities} disabled={busy} onSaved={updated => setConversations(previous => previous.map(c => c.id === updated.id ? updated : c))} />
      : <Card title={<><SlidersOutlined /> 聊天设置</>}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="创建会话后配置模型" /></Card>}
      <div className="next-step-card"><span className="eyebrow">LOCAL VOICE</span><h3>先给菜菜一个声音</h3><p>上传熟悉的参考录音，试听不同语气，再为当前聊天选择音色。</p>
        <button onClick={() => setPage('voices')}>管理本地音色 <ArrowRightOutlined /></button></div>
    </aside></div></div>}

    {page === 'voices' && <VoicesPage api={api} voices={voices} onChanged={refreshVoices} />}

    {page === 'channels' && <div className="page-body"><div className="section-heading"><div><h2>下一站，在微信里见</h2><p>微信接入安排在本地语音和桌宠之后。</p></div><Tag>能力预览</Tag></div>
      <div className="channel-grid"><Card><div className="channel-icon wechat"><WechatOutlined /></div><Tag color="gold">待接入</Tag><h2>普通微信好友聊天</h2><p>像和好友聊天一样，给菜菜发消息并收到回复。</p>
        <ul><li>已预留个人微信桥接接口</li><li>尚未实现扫码登录和真实消息收发</li><li>下一步验证好友文字与原生语音收发</li></ul><Button disabled block>微信登录 · 暂未开放</Button></Card>
      <Card><div className="channel-icon voice"><AudioOutlined /></div><Tag color="green">本地语音</Tag><h2>专属音色回复</h2><p>参考录音、本地合成、语气指令和试听在独立页面管理。</p>
        <ul><li>音色管理与试听已开放</li><li>先安装本地模型，再生成语音</li><li>语音识别与微信语音投递后续接入</li></ul><Button block onClick={() => setPage('voices')}>打开音色与语音</Button></Card></div>
      <Alert type="info" showIcon message="现在可以测试什么？" description="添加中转站、选择模型、修改角色设定，并直接在「聊天测试」中验证文字回复。" />
    </div>}

    {page === 'connection' && <div className="page-body connection-page"><Card title={<><LinkOutlined /> 后端连接</>}>
      <div className="connection-status"><Badge status="success" text="已连接当前后端" /><code>127.0.0.1:8000</code></div>
      <p className="muted">请求由前端开发代理转发到本地后端。此页面用于本地开发测试。</p>
      <ConnectionForm initialToken={token} connecting={connecting || busy} onConnect={connect} />
      <Button danger icon={<DisconnectOutlined />} disabled={busy || connecting} onClick={disconnect}>断开并清除令牌</Button>
    </Card><Card title="工作台能力"><div className="capability-row"><span>模型对话</span><Tag color="green">OpenAI 兼容</Tag></div>
      <div className="capability-row"><span>本地模拟回复</span><Tag color={capabilities?.debug_mock_enabled ? 'green' : 'default'}>{capabilities?.debug_mock_enabled ? '后端已开启' : '未开启'}</Tag></div>
      <div className="capability-row"><span>语音合成</span><Tag color="green">本地引擎 · 在音色页检查状态</Tag></div>
      <div className="capability-row"><span>微信 / 语音识别</span><Tag>待接入</Tag></div>
      <p className="muted">令牌和 API Key 不会写入前端源码。后端环境文件不要提交到 Git。</p></Card></div>}
    <footer className="workspace-footer"><span>CAICAI BOT</span><span>一点智能，一点陪伴。</span></footer>
  </main><Modal title="新建测试会话" open={newChatOpen} confirmLoading={creating} okText="创建会话"
    cancelText="取消" okButtonProps={{ disabled: !newChatName.trim() }} onOk={createConversation}
    onCancel={() => !creating && setNewChatOpen(false)} closable={!creating} maskClosable={!creating}>
    <p className="muted">每个会话有独立的模型设置和聊天记录，不会发送到微信。</p>
    <label htmlFor="conversation-name">会话名称</label><Input id="conversation-name" value={newChatName} maxLength={200}
      onChange={event => setNewChatName(event.target.value)} onPressEnter={() => !creating && createConversation()}
      placeholder="例如：我的日常助手" className="conversation-name" />
  </Modal></div>;
}
