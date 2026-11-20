import { useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Form, Input, Modal, Switch } from 'antd';
import { AudioMutedOutlined, AudioOutlined, SettingOutlined } from '@ant-design/icons';
import type { Api } from './api';
import { subscribeAudioActivity, subscribeDesktopState } from './desktop';
import { matchWakeCommand, MicrophoneCapture, readVoiceSettings, validWakeWord,
  VOICE_SETTINGS_KEY, type VoiceInputSettings } from './voice-input';

type Session = {
  controller: AbortController; capture: MicrophoneCapture; queue: Blob[];
  processing: boolean; sending: boolean; awake: boolean; timer?: ReturnType<typeof setTimeout>;
  generation: number;
};

function microphoneError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return '未获得麦克风权限。请在浏览器或 macOS「系统设置 → 隐私与安全性 → 麦克风」中允许访问后重试。';
    }
    if (error.name === 'NotFoundError') return '未找到麦克风，请连接录音设备后重试。';
    if (error.name === 'NotReadableError') return '麦克风无法使用，请检查是否被其他应用占用。';
  }
  return error instanceof Error ? error.message : '无法开始语音聊天，请检查麦克风后重试。';
}

export function VoiceChat({ api, disabled, blocked, hasVoice, onStart, onSend }: {
  api: Pick<Api, 'recognitionStatus' | 'transcribeSpeech'>; disabled: boolean; blocked: boolean;
  hasVoice: boolean; onStart: () => void; onSend: (text: string) => Promise<void>;
}) {
  const { message } = AntApp.useApp();
  const [settings, setSettings] = useState(readVoiceSettings);
  const [editing, setEditing] = useState<VoiceInputSettings>(settings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [awake, setAwake] = useState(false);
  const [outputBusy, setOutputBusy] = useState(false);
  const [lastHeard, setLastHeard] = useState('');
  const [error, setError] = useState('');
  const session = useRef<Session | null>(null);
  const callbacks = useRef({ onSend, onStart }); callbacks.current = { onSend, onStart };
  const paused = useRef(false); paused.current = blocked || outputBusy || settingsOpen;

  function stop() {
    const current = session.current; session.current = null;
    if (current) {
      current.controller.abort(); clearTimeout(current.timer); current.queue = []; current.capture.stop();
    }
    setRunning(false); setStarting(false); setSpeaking(false); setRecognizing(false); setAwake(false);
  }

  useEffect(() => {
    let audioBusy = false; let desktopBusy = false;
    const update = () => setOutputBusy(audioBusy || desktopBusy);
    const audio = subscribeAudioActivity(value => { audioBusy = value; update(); });
    const desktop = subscribeDesktopState(state => {
      desktopBusy = state.thinking || state.speaking || state.waiting; update();
    });
    return () => { audio(); desktop(); stop(); };
  }, []);

  useEffect(() => {
    const current = session.current;
    current?.capture.pause(paused.current || !!current.sending);
    if (current && paused.current) {
      current.generation++;
      current.queue = []; clearTimeout(current.timer); current.awake = false; setAwake(false);
    }
  }, [blocked, outputBusy, settingsOpen]);
  useEffect(() => { if (disabled) stop(); }, [disabled]);

  function arm(current: Session) {
    clearTimeout(current.timer); current.awake = true; setAwake(true);
    current.timer = setTimeout(() => {
      if (session.current !== current) return;
      current.awake = false; setAwake(false);
    }, 12000);
  }

  async function drain(current: Session) {
    if (current.processing) return;
    current.processing = true; setRecognizing(true);
    try {
      while (current.queue.length && session.current === current && !paused.current) {
        const audio = current.queue.shift()!;
        const generation = current.generation;
        const result = await api.transcribeSpeech(audio, current.controller.signal);
        if (session.current !== current || paused.current || current.controller.signal.aborted) return;
        if (generation !== current.generation) continue;
        const text = result.text.trim();
        if (!text) continue;
        setLastHeard(text);
        let command = text;
        if (settings.wakeEnabled) {
          const remaining = await matchWakeCommand(text, settings.wakeWord);
          if (session.current !== current || paused.current) return;
          if (generation !== current.generation) continue;
          if (!current.awake && remaining === null) continue;
          command = remaining ?? text;
          if (!command) { arm(current); continue; }
        }
        clearTimeout(current.timer); current.awake = false; setAwake(false);
        current.queue = []; current.sending = true; current.capture.pause(true);
        setSpeaking(false); setRecognizing(false);
        try { await callbacks.current.onSend(command); }
        finally { current.sending = false; }
        if (session.current === current) current.capture.pause(paused.current);
      }
    } catch (reason) {
      if (session.current === current && !current.controller.signal.aborted) {
        stop(); setError(microphoneError(reason));
      }
    } finally {
      current.processing = false;
      if (session.current === current) setRecognizing(false);
    }
  }

  async function start() {
    if (session.current || disabled || blocked) return;
    setError(''); setLastHeard(''); setStarting(true);
    callbacks.current.onStart();
    const controller = new AbortController();
    const capture = new MicrophoneCapture(audio => {
      const current = session.current;
      if (!current || current.capture !== capture || paused.current || current.sending) return;
      // Keep at most two utterances while the local model catches up.
      if (current.queue.length >= 2) return;
      current.queue.push(audio); void drain(current);
    }, setSpeaking, detail => {
      if (session.current?.capture === capture) { stop(); setError(detail); }
    });
    const current: Session = { controller, capture, queue: [], processing: false, sending: false, awake: false, generation: 0 };
    session.current = current;
    try {
      const status = await api.recognitionStatus(controller.signal);
      if (session.current !== current) return;
      if (!status.available) throw new Error(status.detail
        + '。在项目根目录执行：backend/.venv/bin/python backend/local_asr/setup.py');
      capture.pause(paused.current);
      await capture.start();
      if (session.current === current) { setRunning(true); setStarting(false); }
    } catch (reason) {
      if (session.current === current && !controller.signal.aborted) { stop(); setError(microphoneError(reason)); }
    }
  }

  function saveSettings() {
    if (editing.wakeEnabled && !validWakeWord(editing.wakeWord)) {
      void message.warning('唤醒词请填写 2～24 个有效字符，不能只包含空格或标点。'); return;
    }
    const next = { ...editing, wakeWord: validWakeWord(editing.wakeWord) ? editing.wakeWord.trim() : settings.wakeWord };
    try { localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(next)); }
    catch { void message.error('无法保存语音设置，请检查浏览器存储权限。'); return; }
    const wasRunning = !!session.current;
    stop(); setSettings(next); setSettingsOpen(false);
    void message.success(wasRunning ? '语音设置已保存，请重新开始语音聊天' : '语音设置已保存');
  }

  const status = starting ? '正在准备本地识别与麦克风…'
    : !running ? '语音聊天未开启'
    : blocked || outputBusy || settingsOpen ? '菜菜正在处理或播放，麦克风识别暂时暂停'
    : recognizing ? '正在本机识别…'
    : speaking ? '正在听，说完停顿约 0.9 秒自动发送'
    : awake ? '已唤醒，请在 12 秒内说出问题'
    : settings.wakeEnabled ? '正在等待唤醒词「' + settings.wakeWord + '」'
    : '正在听，说完停顿约 0.9 秒自动发送';

  return <div className={'voice-chat' + (running ? ' voice-chat-active' : '')}>
    <div className="voice-chat-controls"><Button data-voice-toggle icon={running || starting ? <AudioMutedOutlined /> : <AudioOutlined />}
      danger={running} disabled={!(running || starting) && (disabled || blocked)}
      onClick={() => { if (session.current) stop(); else void start(); }}>
      {starting ? '取消启动语音' : running ? '结束语音聊天' : '开始语音聊天'}
    </Button><Button data-voice-settings type="text" icon={<SettingOutlined />} onClick={() => { setEditing(settings); setSettingsOpen(true); }}>语音设置</Button>
      <span className="voice-chat-status" role="status" aria-live="polite"><i aria-hidden="true" />{status}</span></div>
    {running && lastHeard && <div className="voice-chat-transcript">最近识别：{lastHeard}</div>}
    {!hasVoice && <div className="field-help">在聊天设置选择并保存朗读音色后，菜菜会用该音色回答。</div>}
    {error && <Alert type="warning" showIcon closable onClose={() => setError('')} message={error} />}
    <Modal title="语音聊天设置" open={settingsOpen} onCancel={() => setSettingsOpen(false)}
      onOk={saveSettings} okText="保存语音设置" cancelText="取消">
      <Form layout="vertical" requiredMark={false}>
        <Form.Item label="启用唤醒词"><Switch aria-label="启用唤醒词" checked={editing.wakeEnabled}
          onChange={wakeEnabled => setEditing(previous => ({ ...previous, wakeEnabled }))} /></Form.Item>
        <Form.Item label="唤醒词" help="2～24 个有效字符，例如：菜菜、你好菜菜、小助手。纯中文唤醒词也按读音匹配。">
          <Input aria-label="唤醒词" value={editing.wakeWord} maxLength={32} disabled={!editing.wakeEnabled}
            onChange={event => setEditing(previous => ({ ...previous, wakeWord: event.target.value }))} /></Form.Item>
      </Form>
      <p className="muted">点击「开始语音聊天」并允许麦克风后生效。开启唤醒词时，每轮先说唤醒词；
        可以连着说「{editing.wakeWord || settings.wakeWord}，今天天气怎么样」，也可以只说唤醒词，等显示已唤醒后再提问。
        关闭唤醒词后，每段说话都会直接发送。每段最长 20 秒。</p>
      <p className="muted">识别在本机进行，不保存麦克风录音；识别出的提问沿用当前会话的模型和音色。
        回复与等待语音播放时暂停识别。设置保存在当前设备，刷新后需要手动开始；结束聊天会释放麦克风。</p>
    </Modal>
  </div>;
}
