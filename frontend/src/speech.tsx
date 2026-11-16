import { useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Empty, Form, Input, Modal, Select, Spin, Tag } from 'antd';
import { AudioOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined, SoundOutlined } from '@ant-design/icons';
import type { Api } from './api';
import type { SpeechJob, SpeechStatus, VoiceProfile } from './types';
import { prepareReference } from './audio';

const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试。';

export function SpeechAudio({ api, kind, id }: { api: Api; kind: 'reference' | 'job'; id: string }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const element = audio.current;
    return () => { element?.pause(); element?.removeAttribute('src'); element?.load(); };
  }, [url]);
  useEffect(() => {
    let disposed = false; let objectUrl = '';
    setUrl(''); setError('');
    const fetchAudio = kind === 'reference' ? api.referenceAudio(id) : api.speechAudio(id);
    void fetchAudio.then(blob => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(reason => { if (!disposed) setError(errorText(reason)); });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, id, kind, generation]);
  if (error) return <div className="speech-error"><span>{error}</span>
    <Button size="small" onClick={() => setGeneration(value => value + 1)}>重新加载音频</Button></div>;
  return url ? <audio ref={audio} controls preload="metadata" src={url} aria-label={kind === 'reference' ? '参考录音' : '合成语音'} />
    : <span className="muted"><Spin size="small" /> 正在读取本地音频…</span>;
}

export function SpeechJobPlayer({ api, jobId, onFinished, onRetry }: {
  api: Api; jobId: string; onFinished?: (job: SpeechJob) => void; onRetry?: () => void;
}) {
  const [job, setJob] = useState<SpeechJob | null>(null);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const callback = useRef(onFinished); callback.current = onFinished;
  useEffect(() => {
    let disposed = false; let timeout: ReturnType<typeof setTimeout> | undefined;
    setJob(null); setError('');
    async function poll() {
      try {
        const next = await api.speechJob(jobId);
        if (disposed) return;
        setJob(next);
        if (next.status === 'queued' || next.status === 'running') timeout = setTimeout(poll, 1500);
        else callback.current?.(next);
      } catch (reason) { if (!disposed) setError(errorText(reason)); }
    }
    void poll();
    return () => { disposed = true; if (timeout) clearTimeout(timeout); };
  }, [api, jobId, generation]);
  return <div className="speech-player">
    {error ? <Alert type="warning" message={error} action={<Button size="small" onClick={() => setGeneration(value => value + 1)}>刷新状态</Button>} />
      : !job || job.status === 'queued' || job.status === 'running' ? <div className="speech-progress"><Spin size="small" />
        <span>{job?.status === 'running' ? '正在本机合成语音，首次加载与编译可能需要几分钟…' : '语音已排队，文字聊天可以继续。'}</span></div>
      : job.status === 'failed' ? <Alert type="warning" message="语音未生成，文字内容已保留" description={job.error}
        action={onRetry && <Button size="small" onClick={onRetry}>重试语音</Button>} />
      : <><SpeechAudio api={api} kind="job" id={job.id} /><small className="muted">
        本地生成 · {job.duration_seconds?.toFixed(1)} 秒音频 · 合成耗时 {job.generation_seconds?.toFixed(1)} 秒</small></>}
  </div>;
}

export function MessageSpeech({ api, conversationId, messageId, initialJobId, canGenerate }: {
  api: Api; conversationId: string; messageId: string; initialJobId: string | null; canGenerate: boolean;
}) {
  const [jobId, setJobId] = useState(initialJobId);
  const [loading, setLoading] = useState(false);
  const { message } = AntApp.useApp();
  useEffect(() => { setJobId(initialJobId); }, [initialJobId]);
  async function generate() {
    if (loading) return;
    setLoading(true);
    try { setJobId((await api.messageSpeech(conversationId, messageId)).id); }
    catch (error) { message.error(errorText(error)); }
    finally { setLoading(false); }
  }
  return jobId ? <SpeechJobPlayer api={api} jobId={jobId} onRetry={canGenerate ? generate : undefined} />
    : canGenerate ? <Button className="read-message" size="small" type="text" icon={<SoundOutlined />} loading={loading} onClick={generate}>用当前音色朗读</Button> : null;
}

export function VoicesPage({ api, voices, onChanged }: {
  api: Api; voices: VoiceProfile[]; onChanged: () => Promise<void>;
}) {
  const { message, modal } = AntApp.useApp();
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [jobId, setJobId] = useState('');
  const [reference, setReference] = useState<VoiceProfile | null>(null);
  const [uploadForm] = Form.useForm(); const [previewForm] = Form.useForm();
  const requestGeneration = useRef(0);
  useEffect(() => {
    let disposed = false;
    void api.speechJobs().then(jobs => {
      if (disposed || !jobs.length) return;
      const job = jobs[0];
      setJobId(job.id);
      setPreviewing(job.status === 'queued' || job.status === 'running');
      setSelected(job.voice_id);
      previewForm.setFieldValue('text', job.text);
    }).catch(error => { if (!disposed) message.warning('暂时无法读取上次试听：' + errorText(error)); });
    return () => { disposed = true; };
  }, [api, previewForm, message]);
  useEffect(() => {
    let disposed = false; let timeout: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const next = await api.speechStatus();
        if (!disposed) { setStatus(next); setStatusError(''); }
      } catch (error) { if (!disposed) setStatusError(errorText(error)); }
      if (!disposed) timeout = setTimeout(refresh, 5000);
    }
    void refresh();
    return () => { disposed = true; if (timeout) clearTimeout(timeout); requestGeneration.current++; };
  }, [api]);
  useEffect(() => {
    if (!voices.some(voice => voice.id === selected)) setSelected(voices[0]?.id || '');
  }, [voices, selected]);
  useEffect(() => {
    previewForm.setFieldValue('style_prompt', voices.find(voice => voice.id === selected)?.style_prompt || '');
  }, [selected, voices, previewForm]);

  async function upload(values: { name: string; reference_text?: string; style_prompt?: string }) {
    if (!file) { message.warning('请先选择一段参考录音'); return; }
    setUploading(true);
    try {
      const wav = await prepareReference(file);
      const body = new FormData();
      body.append('name', values.name.trim()); body.append('reference_text', values.reference_text || '');
      body.append('style_prompt', values.style_prompt || ''); body.append('audio', wav, 'reference.wav');
      const created = await api.uploadVoice(body);
      await onChanged(); setSelected(created.id); setOpen(false); setFile(null); uploadForm.resetFields();
      message.success('音色参考已保存，选择文字即可试听');
    } catch (error) { message.error(errorText(error)); }
    finally { setUploading(false); }
  }
  async function preview(values: { text: string; style_prompt: string }) {
    if (!selected || previewing) return;
    const generation = ++requestGeneration.current;
    setPreviewing(true); setJobId('');
    try {
      const job = await api.previewVoice(selected, values.text.trim(), values.style_prompt);
      if (generation === requestGeneration.current) {
        setJobId(job.id);
        if (job.status === 'completed' || job.status === 'failed') setPreviewing(false);
      }
    } catch (error) { if (generation === requestGeneration.current) { message.error(errorText(error)); setPreviewing(false); } }
  }
  function remove(voice: VoiceProfile) {
    modal.confirm({ title: '删除音色「' + voice.name + '」？',
      content: '将删除参考录音及该音色生成的音频，相关会话恢复文字回复。已有聊天文字保留。',
      okText: '删除音色', cancelText: '取消', okButtonProps: { danger: true },
      async onOk() {
        try {
          await api.deleteVoice(voice.id); await onChanged();
          if (selected === voice.id) { setJobId(''); setPreviewing(false); }
          message.success('音色及相关音频已删除');
        } catch (error) { message.error(errorText(error)); throw error; }
      },
    });
  }
  return <div className="page-body voice-page">
    <div className="section-heading"><div><h2>让回应有熟悉的声音</h2><p>上传参考录音，在本机复刻音色，用语气指令调整表达。</p></div>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => { setFile(null); uploadForm.resetFields(); setOpen(true); }}>添加音色</Button></div>
    <Card className="speech-engine"><div className="speech-engine-header"><div><AudioOutlined /> <strong>本地语音引擎</strong>
      <Tag color={status?.available ? 'green' : 'gold'}>{status?.model || 'VoxCPM2-4bit'}</Tag></div>
      <Button icon={<ReloadOutlined />} onClick={async () => { try { setStatus(await api.speechStatus()); setStatusError(''); await onChanged(); } catch (error) { setStatusError(errorText(error)); } }}>刷新状态</Button></div>
      <p className="muted">{statusError || status?.detail || '正在检查本地环境…'}</p>
      <small className="muted">参考录音和语音推理保留在本机 · 无云端语音调用费 · 首次生成需要加载和编译模型</small>
      {status && !status.available && <Alert className="inline-alert" type="info" message="先准备本地环境"
        description={<><p>在项目根目录执行一次，然后刷新状态：</p><code>backend/.venv/bin/python backend/local_tts/setup.py</code><p>首次会下载约 2.3 GB 模型。现在也可以先添加参考音色。</p></>} />}
    </Card>
    <div className="voice-workspace"><section><h3>我的音色 <Tag>{voices.length}</Tag></h3>
      {!voices.length ? <Card><Empty description="添加一段清晰录音，创建第一个参考音色" /></Card>
        : <div className="voice-list">{voices.map(voice => <Card key={voice.id} className={'voice-card ' + (selected === voice.id ? 'voice-selected' : '')}>
          <div className="voice-card-heading"><span className="voice-icon"><SoundOutlined /></span><div><h3>{voice.name}</h3><span className="muted">参考录音 {voice.duration_seconds.toFixed(1)} 秒 · 本地保存</span></div></div>
          <p className="voice-style">{voice.style_prompt || '自然表达 · 可在试听时填写语气指令'}</p>
          <div className="voice-actions"><Button type={selected === voice.id ? 'primary' : 'default'} disabled={previewing}
            onClick={() => setSelected(voice.id)}>{selected === voice.id ? '当前试听音色' : '选择试听'}</Button>
            <Button type="text" onClick={() => setReference(voice)}>听原音</Button>
            <Button type="text" danger aria-label={'删除音色' + voice.name} icon={<DeleteOutlined />} onClick={() => remove(voice)} /></div>
        </Card>)}</div>}
    </section><Card title={<><SoundOutlined /> 音色试听</>} className="voice-preview">
      <Form name="voice-preview" form={previewForm} layout="vertical" requiredMark={false} initialValues={{ text: '你好呀，我是菜菜。今天也很高兴见到你，我们慢慢聊。', style_prompt: '' }} onFinish={preview}>
        <Form.Item label="试听音色"><Select value={selected || undefined} onChange={setSelected} disabled={previewing}
          placeholder="先添加一个音色" options={voices.map(voice => ({ value: voice.id, label: voice.name }))} /></Form.Item>
        <Form.Item name="text" label="要说的话" rules={[{ required: true, whitespace: true, message: '请输入试听文字' }]}><Input.TextArea rows={4} maxLength={600} showCount disabled={previewing} /></Form.Item>
        <Form.Item name="style_prompt" label="语音表达提示词"><Input.TextArea rows={3} maxLength={500} disabled={previewing} placeholder="例如：语气温柔自然，语速稍慢，像和熟悉的人轻声聊天" /></Form.Item>
        <div className="voice-presets">{['温柔自然，语速稍慢', '开心活泼，语气轻快', '平静清晰，自然叙述'].map(value => <Button key={value} size="small" disabled={previewing} onClick={() => previewForm.setFieldValue('style_prompt', value)}>{value}</Button>)}</div>
        <p className="muted compact">语气指令与台词分开填写。实际音色和语气效果取决于参考录音与模型。</p>
        <Button type="primary" htmlType="submit" block icon={<SoundOutlined />} loading={previewing} disabled={!selected || !status?.available || !!statusError}>生成试听</Button>
      </Form>
      {jobId && <SpeechJobPlayer api={api} jobId={jobId} onFinished={() => setPreviewing(false)} />}
    </Card></div>
    <Modal title="添加本地音色" open={open} onCancel={() => !uploading && setOpen(false)} footer={null}
      destroyOnClose closable={!uploading} maskClosable={!uploading}>
      <p className="muted">使用本人或已获授权的录音。选择 3～30 秒单人、少噪声、无背景音乐的 WAV 或 MP3，文件不超过 20 MB。</p>
      <Form name="voice-upload" form={uploadForm} layout="vertical" requiredMark={false} onFinish={upload}>
        <Form.Item name="name" label="音色名称" rules={[{ required: true, whitespace: true, message: '请填写音色名称' }]}><Input maxLength={100} disabled={uploading} placeholder="例如：菜菜的声音" /></Form.Item>
        <Form.Item label="参考录音" required><input key={open ? 'open' : 'closed'} aria-label="参考录音文件" type="file" accept="audio/wav,audio/x-wav,audio/mpeg,.wav,.mp3" disabled={uploading} onChange={event => setFile(event.target.files?.[0] || null)} /><small className="muted">浏览器会在本机转换为标准 WAV，再保存到本地后端。</small></Form.Item>
        <Form.Item name="style_prompt" label="默认语气（可选）"><Input.TextArea rows={2} maxLength={500} disabled={uploading} placeholder="语气温柔自然，语速稍慢" /></Form.Item>
        <Form.Item name="reference_text" label="录音文字备注（可选）"><Input.TextArea rows={2} maxLength={2000} disabled={uploading} placeholder="用于记录原音内容，当前复刻模式不要求提供转写" /></Form.Item>
        <Button type="primary" htmlType="submit" block loading={uploading} disabled={!file}>保存参考音色</Button>
      </Form>
    </Modal>
    <Modal title={reference ? '参考录音 · ' + reference.name : '参考录音'} open={!!reference} onCancel={() => setReference(null)} footer={null} destroyOnClose>
      {reference && <SpeechAudio api={api} kind="reference" id={reference.id} />}
    </Modal>
  </div>;
}
