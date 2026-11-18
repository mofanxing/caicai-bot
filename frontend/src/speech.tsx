import { useEffect, useId, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Empty, Form, Input, Modal, Select, Spin, Tag } from 'antd';
import { AudioOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined, SoundOutlined } from '@ant-design/icons';
import type { Api } from './api';
import type { SpeechJob, SpeechStatus, VoiceProfile } from './types';
import { prepareReference } from './audio';
import { decodeSpeechAudio, prepareSpeechPlayback, SpeechPlayback } from './playback';
import { reportAudioPlayback, reportSpeechWaiting } from './desktop';
export { prepareSpeechPlayback } from './playback';

const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试。';
const PLAY_EVENT = 'caicai-audio-start';

function announcePlayback(id: string) {
  window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: id }));
}

export function stopSpeechPlayback() { announcePlayback(''); }

export function SpeechAudio({ api, kind, id, text = '' }: { api: Api; kind: 'reference' | 'job'; id: string; text?: string }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);
  const playerId = useId();
  useEffect(() => {
    const stop = (event: Event) => {
      if ((event as CustomEvent).detail !== playerId) audio.current?.pause();
    };
    window.addEventListener(PLAY_EVENT, stop);
    return () => window.removeEventListener(PLAY_EVENT, stop);
  }, [playerId]);
  useEffect(() => {
    const element = audio.current;
    return () => { if (element) { reportAudioPlayback(element, false); element.pause(); element.removeAttribute('src'); element.load(); } };
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
  return url ? <audio ref={audio} controls preload="metadata" src={url} onPlay={() => announcePlayback(playerId)}
    onPlaying={event => reportAudioPlayback(event.currentTarget, true, 'reply', text)}
    onPause={event => reportAudioPlayback(event.currentTarget, false)}
    onEnded={event => reportAudioPlayback(event.currentTarget, false)}
    onWaiting={event => reportAudioPlayback(event.currentTarget, false)}
    onError={event => reportAudioPlayback(event.currentTarget, false)}
    aria-label={kind === 'reference' ? '参考录音' : '合成语音'} />
    : <span className="muted"><Spin size="small" /> 正在读取本地音频…</span>;
}

export function SpeechJobPlayer({ api, jobId, onFinished, onRetry, autoPlay = false }: {
  api: Api; jobId: string; onFinished?: (job: SpeechJob) => void; onRetry?: () => void; autoPlay?: boolean;
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
        if (next.status === 'queued' || next.status === 'running') timeout = setTimeout(poll, 500);
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
      : autoPlay ? <SpeechPlaylist api={api} jobIds={[job.id]} autoPlay />
      : <><SpeechAudio api={api} kind="job" id={job.id} text={job.text} /><small className="muted">
        本地生成 · {job.duration_seconds?.toFixed(1)} 秒音频 · 合成耗时 {job.generation_seconds?.toFixed(1)} 秒</small></>}
  </div>;
}

export function SpeechPlaylist({ api, jobIds, autoPlay = false, streaming = false, playbackMode = 'realtime' }: {
  api: Api; jobIds: string[]; autoPlay?: boolean; streaming?: boolean; playbackMode?: 'smooth' | 'realtime';
}) {
  const [jobs, setJobs] = useState<Record<string, SpeechJob>>({});
  const jobsRef = useRef(jobs); jobsRef.current = jobs;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(autoPlay);
  const [readyId, setReadyId] = useState('');
  const [buffering, setBuffering] = useState(true);
  const [bufferExpired, setBufferExpired] = useState(false);
  const [preparedVersion, setPreparedVersion] = useState(0);
  const prepared = useRef(new Map<string, AudioBuffer>());
  const preparing = useRef(new Set<string>());
  const epoch = useRef(0);
  const windowIds = jobIds.slice(index, index + 3);
  const windowRef = useRef(windowIds); windowRef.current = windowIds;
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const playback = useRef<SpeechPlayback | null>(null);
  const loadedBuffer = useRef<{ id: string; buffer: AudioBuffer } | null>(null);
  const playerId = useId();
  const idsKey = jobIds.join(',');
  const currentId = jobIds[index];
  const job = jobs[currentId];
  const complete = !streaming && index >= jobIds.length;
  useEffect(() => {
    reportSpeechWaiting(playerId, playing && buffering && !complete && !error && job?.status !== 'failed');
  }, [playerId, playing, buffering, complete, error, job?.status]);
  useEffect(() => () => reportSpeechWaiting(playerId, false), [playerId]);
  const completedJobs = jobIds.map(id => jobs[id]).filter(item => item?.status === 'completed');
  const totalDuration = completedJobs.reduce((sum, item) => sum + (item.duration_seconds || 0), 0);
  const totalGeneration = completedJobs.reduce((sum, item) => sum + (item.generation_seconds || 0), 0);
  const slowerThanPlayback = totalDuration > 0 && totalGeneration / totalDuration > 1.1;
  const allSettled = !streaming && jobIds.every(id => ['completed', 'failed'].includes(jobs[id]?.status));
  let readyDuration = 0; let readyCount = 0;
  for (const id of windowIds) {
    const buffer = prepared.current.get(id);
    if (!buffer) break;
    readyDuration += buffer.duration; readyCount++;
  }
  const enoughBuffer = playbackMode === 'realtime' || allSettled || bufferExpired
    || (readyCount >= 2 && readyDuration >= 8);
  useEffect(() => {
    setBufferExpired(false);
    if (!playing || readyId !== currentId || !readyId || playbackMode !== 'smooth') return;
    // Bound each buffering pause even when inference cannot keep up with speech.
    const timer = setTimeout(() => setBufferExpired(true), 2500);
    return () => clearTimeout(timer);
  }, [currentId, readyId, playing, playbackMode]);
  useEffect(() => { setPlaying(autoPlay); }, [autoPlay]);
  useEffect(() => {
    const player = new SpeechPlayback(() => setIndex(value => value + 1));
    epoch.current++;
    playback.current = player;
    return () => { epoch.current++; prepared.current.clear(); preparing.current.clear();
      player.dispose(); if (playback.current === player) playback.current = null; };
  }, []);
  useEffect(() => {
    const stop = (event: Event) => {
      if ((event as CustomEvent).detail !== playerId) setPlaying(false);
    };
    window.addEventListener(PLAY_EVENT, stop);
    return () => window.removeEventListener(PLAY_EVENT, stop);
  }, [playerId]);
  useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const ids = idsKey.split(',').filter(Boolean);
        const pending = ids.filter(id => !jobsRef.current[id]
          || ['queued', 'running'].includes(jobsRef.current[id].status));
        const next = await Promise.all(pending.map(id => api.speechJob(id)));
        if (disposed) return;
        setJobs(previous => Object.fromEntries([...Object.entries(previous), ...next.map(item => [item.id, item])]));
        setError('');
        if (next.some(item => ['queued', 'running'].includes(item.status))) timer = setTimeout(poll, 500);
      } catch (reason) { if (!disposed) { setError(errorText(reason)); } }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [api, idsKey, reload]);
  const prefetchKey = windowIds.map(id => id + ':' + jobs[id]?.status).join(',');
  useEffect(() => {
    const generation = epoch.current;
    for (const id of prepared.current.keys()) if (!windowRef.current.includes(id)) prepared.current.delete(id);
    for (const id of windowRef.current) {
      if (jobsRef.current[id]?.status !== 'completed' || prepared.current.has(id) || preparing.current.has(id)) continue;
      preparing.current.add(id);
      void api.speechAudio(id).then(decodeSpeechAudio).then(buffer => {
        if (epoch.current !== generation || !windowRef.current.includes(id)) return;
        prepared.current.set(id, buffer); setPreparedVersion(value => value + 1);
      }).catch(reason => {
        if (epoch.current === generation && windowRef.current[0] === id) setError(errorText(reason));
      }).finally(() => { if (epoch.current === generation) preparing.current.delete(id); });
    }
  }, [api, prefetchKey, reload]);
  useEffect(() => {
    const player = playback.current; const buffer = prepared.current.get(currentId);
    if (buffer && player) {
      if (loadedBuffer.current?.id === currentId && loadedBuffer.current.buffer === buffer) return;
      player.loadBuffer(buffer, jobsRef.current[currentId]?.text || '');
      loadedBuffer.current = { id: currentId, buffer }; setReadyId(currentId);
    } else { loadedBuffer.current = null; player?.pause(); setReadyId(''); setBuffering(true); }
  }, [currentId, preparedVersion]);
  useEffect(() => { if (enoughBuffer && readyId === currentId && readyId) setBuffering(false); },
    [enoughBuffer, readyId, currentId]);
  useEffect(() => {
    const player = playback.current;
    let disposed = false;
    if (readyId === currentId && readyId && playing && !buffering && player) {
      announcePlayback(playerId);
      void player.play().catch(() => {
        if (!disposed) { setPlaying(false); setError('浏览器暂未允许自动播放，请点击「开始朗读」。'); }
      });
    } else player?.pause();
    return () => { disposed = true; };
  }, [readyId, currentId, playing, buffering, playerId]);
  async function retry() {
    prepared.current.delete(currentId);
    playback.current?.pause(); loadedBuffer.current = null; setReadyId(''); setBuffering(true);
    if (job) {
      try {
        const next = await api.retrySpeechJob(job.id);
        setJobs(previous => ({ ...previous, [next.id]: next }));
        jobsRef.current = { ...jobsRef.current, [next.id]: next };
      } catch (reason) { setError(errorText(reason)); return; }
    }
    setError(''); setReload(value => value + 1);
  }
  return <div className="speech-player">
    <div className="speech-progress"><Button size="small" icon={<SoundOutlined />} onClick={() => {
      if (!playing || complete) void prepareSpeechPlayback().catch(() => {});
      if (complete) { setIndex(0); setPlaying(true); }
      else if (playing) { stopSpeechPlayback(); setPlaying(false); }
      else setPlaying(true);
    }}>{complete ? '重新朗读' : playing ? '暂停朗读' : '开始朗读'}</Button>
      <span>{complete ? '朗读完成' : job?.status === 'failed' ? '此段语音生成失败，文字已保留'
        : playing && buffering && playbackMode === 'smooth' ? '正在预载后续语音，首段就绪后最多额外缓冲 2.5 秒…'
        : job?.status === 'completed' ? `第 ${index + 1} 段 · ${playing ? '正在朗读' : '已就绪'}`
        : job?.status === 'running' ? '正在本机合成语音…' : '等待下一段语音…'}</span></div>
    {(error || job?.status === 'failed') && <div className="speech-error"><span>{error || job?.error}</span>
      <Button size="small" onClick={() => void retry()}>重试语音</Button>
      {job?.status === 'failed' && <Button size="small" onClick={() => setIndex(value => value + 1)}>跳过此段</Button>}</div>}
    {!!completedJobs.length && <small className="muted">本地生成 · 已完成 {completedJobs.length}/{jobIds.length} 段
      {' · 音频 ' + completedJobs.reduce((total, item) => total + (item.duration_seconds || 0), 0).toFixed(1) + ' 秒'}
      {' · 合成耗时 ' + completedJobs.reduce((total, item) => total + (item.generation_seconds || 0), 0).toFixed(1) + ' 秒'}
      {slowerThanPlayback && ' · 本机合成慢于播报，后续分段可能短暂等待'}</small>}
  </div>;
}

export function MessageSpeech({ api, conversationId, messageId, initialJobId, jobIds, canGenerate, autoPlay, streaming, playbackMode }: {
  api: Api; conversationId: string; messageId: string; initialJobId: string | null; canGenerate: boolean;
  jobIds?: string[]; autoPlay?: boolean; streaming?: boolean;
  playbackMode?: 'smooth' | 'realtime';
}) {
  const [jobId, setJobId] = useState(initialJobId);
  const [generatedIds, setGeneratedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [manualRead, setManualRead] = useState(false);
  const { message } = AntApp.useApp();
  useEffect(() => { setJobId(initialJobId); }, [initialJobId]);
  async function generate() {
    if (loading) return;
    void prepareSpeechPlayback().catch(() => {}); stopSpeechPlayback();
    setManualRead(true);
    setLoading(true);
    try {
      const result = await api.messageSpeech(conversationId, messageId);
      setJobId(result.id); setGeneratedIds(result.speech_job_ids || [result.id]);
    }
    catch (error) { message.error(errorText(error)); }
    finally { setLoading(false); }
  }
  const ids = generatedIds.length ? generatedIds : jobIds?.length ? jobIds : jobId ? [jobId] : [];
  return ids.length ? <SpeechPlaylist api={api} jobIds={ids} autoPlay={autoPlay || manualRead} streaming={streaming} playbackMode={playbackMode} />
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
  const [previewAutoplay, setPreviewAutoplay] = useState(false);
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
    void prepareSpeechPlayback().catch(() => {}); stopSpeechPlayback();
    const generation = ++requestGeneration.current;
    setPreviewing(true); setJobId('');
    try {
      const job = await api.previewVoice(selected, values.text.trim(), values.style_prompt);
      if (generation === requestGeneration.current) {
        setJobId(job.id); setPreviewAutoplay(true);
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
    <div className="section-heading"><div><h2>让回应有熟悉的声音</h2><p>上传参考录音，在本机复刻音色与说话方式。</p></div>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => { setFile(null); uploadForm.resetFields(); setOpen(true); }}>添加音色</Button></div>
    <Card className="speech-engine"><div className="speech-engine-header"><div><AudioOutlined /> <strong>本地语音引擎</strong>
      <Tag color={status?.available ? 'green' : 'gold'}>{status?.model || 'VoxCPM2-4bit'}</Tag></div>
      <Button icon={<ReloadOutlined />} onClick={async () => { try { setStatus(await api.speechStatus()); setStatusError(''); await onChanged(); } catch (error) { setStatusError(errorText(error)); } }}>刷新状态</Button></div>
      <p className="muted">{statusError || status?.detail || '正在检查本地环境…'}</p>
      {status?.supports_style_prompt === false && <Alert className="inline-alert" type="info"
        message="当前音色复刻不使用自由文本语气指令"
        description="为避免把指令念出来，当前模型只朗读正文，语气跟随参考录音。原有提示词保留，但暂不参与合成。" />}
      <small className="muted">参考录音和语音推理保留在本机 · 无云端语音调用费 · 首次生成需要加载和编译模型</small>
      {status && !status.available && <Alert className="inline-alert" type="info" message="先准备本地环境"
        description={<><p>在项目根目录执行一次，然后刷新状态：</p><code>backend/.venv/bin/python backend/local_tts/setup.py</code><p>首次会下载约 2.3 GB 模型。现在也可以先添加参考音色。</p></>} />}
    </Card>
    <div className="voice-workspace"><section><h3>我的音色 <Tag>{voices.length}</Tag></h3>
      {!voices.length ? <Card><Empty description="添加一段清晰录音，创建第一个参考音色" /></Card>
        : <div className="voice-list">{voices.map(voice => <Card key={voice.id} className={'voice-card ' + (selected === voice.id ? 'voice-selected' : '')}>
          <div className="voice-card-heading"><span className="voice-icon"><SoundOutlined /></span><div><h3>{voice.name}</h3><span className="muted">参考录音 {voice.duration_seconds.toFixed(1)} 秒 · 本地保存</span></div></div>
          <p className="voice-style">{status?.supports_style_prompt === false ? '表达跟随参考录音' : voice.style_prompt || '自然表达'}</p>
          <div className="voice-actions"><Button type={selected === voice.id ? 'primary' : 'default'} disabled={previewing}
            onClick={() => setSelected(voice.id)}>{selected === voice.id ? '当前试听音色' : '选择试听'}</Button>
            <Button type="text" onClick={() => setReference(voice)}>听原音</Button>
            <Button type="text" danger aria-label={'删除音色' + voice.name} icon={<DeleteOutlined />} onClick={() => remove(voice)} /></div>
        </Card>)}</div>}
    </section><Card title={<><SoundOutlined /> 音色试听</>} className="voice-preview">
      <Form name="voice-preview" form={previewForm} layout="vertical" requiredMark={false} initialValues={{ text: '你好呀，我是菜菜。今天也很高兴见到你，我们慢慢聊。', style_prompt: '' }} onFinish={preview}>
        <Form.Item label="试听音色"><Select value={selected || undefined} onChange={setSelected} disabled={previewing}
          placeholder="先添加一个音色" options={voices.map(voice => ({ value: voice.id, label: voice.name }))} /></Form.Item>
        <Form.Item name="text" label="要说的话" rules={[{ required: true, whitespace: true, message: '请输入试听文字' }]}><Input.TextArea rows={4} showCount disabled={previewing} /></Form.Item>
        <Form.Item name="style_prompt" label="语音表达提示词"><Input.TextArea rows={3} maxLength={500} disabled={previewing || status?.supports_style_prompt === false} placeholder="语气跟随参考录音" /></Form.Item>
        {status?.supports_style_prompt !== false && <div className="voice-presets">{['温柔自然，语速稍慢', '开心活泼，语气轻快', '平静清晰，自然叙述'].map(value => <Button key={value} size="small" disabled={previewing} onClick={() => previewForm.setFieldValue('style_prompt', value)}>{value}</Button>)}</div>}
        <p className="muted compact">只朗读“要说的话”。当前复刻模式的语气以参考录音为准。</p>
        <Button type="primary" htmlType="submit" block icon={<SoundOutlined />} loading={previewing}
          onClick={() => void prepareSpeechPlayback().catch(() => {})}
          disabled={!selected || !status?.available || !!statusError}>生成并自动试听</Button>
      </Form>
      {jobId && <SpeechJobPlayer key={jobId} api={api} jobId={jobId} autoPlay={previewAutoplay} onFinished={() => setPreviewing(false)} />}
    </Card></div>
    <Modal title="添加本地音色" open={open} onCancel={() => !uploading && setOpen(false)} footer={null}
      destroyOnClose closable={!uploading} maskClosable={!uploading}>
      <p className="muted">使用本人或已获授权的录音。选择 3～30 秒单人、少噪声、无背景音乐的 WAV 或 MP3，文件不超过 20 MB。</p>
      <Form name="voice-upload" form={uploadForm} layout="vertical" requiredMark={false} onFinish={upload}>
        <Form.Item name="name" label="音色名称" rules={[{ required: true, whitespace: true, message: '请填写音色名称' }]}><Input maxLength={100} disabled={uploading} placeholder="例如：菜菜的声音" /></Form.Item>
        <Form.Item label="参考录音" required><input key={open ? 'open' : 'closed'} aria-label="参考录音文件" type="file" accept="audio/wav,audio/x-wav,audio/mpeg,.wav,.mp3" disabled={uploading} onChange={event => setFile(event.target.files?.[0] || null)} /><small className="muted">浏览器会在本机转换为标准 WAV，再保存到本地后端。</small></Form.Item>
        <Form.Item name="style_prompt" label="默认语气（可选）" extra="当前本地复刻模式暂不使用该指令。"><Input.TextArea rows={2} maxLength={500} disabled={uploading || status?.supports_style_prompt === false} /></Form.Item>
        <Form.Item name="reference_text" label="录音文字备注（可选）"><Input.TextArea rows={2} maxLength={2000} disabled={uploading} placeholder="用于记录原音内容，当前复刻模式不要求提供转写" /></Form.Item>
        <Button type="primary" htmlType="submit" block loading={uploading} disabled={!file}>保存参考音色</Button>
      </Form>
    </Modal>
    <Modal title={reference ? '参考录音 · ' + reference.name : '参考录音'} open={!!reference} onCancel={() => setReference(null)} footer={null} destroyOnClose>
      {reference && <SpeechAudio api={api} kind="reference" id={reference.id} />}
    </Modal>
  </div>;
}
