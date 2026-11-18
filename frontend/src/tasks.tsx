import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Collapse, Drawer, Empty, Form, Input, Modal, Select, Space, Tag } from 'antd';
import { DeleteOutlined, FolderOpenOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { isDesktop, selectProjectDirectory } from './desktop';
import { prepareSpeechPlayback } from './playback';
import type { Api } from './api';
import type { Conversation, TaskDetail, TaskEvent, TaskPlugin, TaskProject, TaskRecord, TaskState } from './types';

const labels: Record<TaskState, string> = { queued: '排队中', running: '执行中', waiting_confirmation: '等待确认',
  cancelling: '正在停止', succeeded: '执行完成', failed: '失败', cancelled: '已取消', interrupted: '中断待核查' };
const terminal = (state: TaskState) => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state);
const errorText = (error: unknown) => error instanceof Error ? error.message : '任务请求失败';
const text = (value: unknown) => typeof value === 'string' ? value : '';
const eventLabel = (event: TaskEvent) => text(event.payload.command) || text(event.payload.message)
  || text(event.payload.tool) || ({ turn_start: '开始执行', step_start: '执行下一步', step_end: '步骤完成',
    turn_end: '执行器结束' } as Record<string, string>)[text(event.payload.phase)] || event.type;

export function useTasks(api: Api, conversationId?: string) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setTasks([]); setError('');
    const refresh = async () => {
      try {
        const result = await api.tasks(conversationId, controller.signal);
        if (!controller.signal.aborted) { setTasks(result); setError(''); }
      } catch (e) { if (!controller.signal.aborted) setError(errorText(e)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 2500); }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, conversationId, revision]);
  return { tasks, error, refresh: () => setRevision(value => value + 1) };
}

export function TaskInspector({ api, id, onClose }: { api: Api; id: string; onClose: () => void }) {
  const { modal, message } = App.useApp();
  const [detail, setDetail] = useState<TaskDetail>();
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [report, setReport] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let after = 0;
    setDetail(undefined); setEvents([]); setError('');
    const refresh = async () => {
      try {
        const result = await api.taskDetail(id, controller.signal);
        // Drain every page before stopping at a terminal task. Events persist independently of windows.
        let page: TaskEvent[];
        do {
          page = await api.taskEvents(id, after, controller.signal);
          if (controller.signal.aborted) return;
          if (page.length) {
            after = page[page.length - 1].seq;
            setEvents(previous => [...previous, ...page.filter(e => !previous.some(p => p.seq === e.seq))]);
          }
        } while (page.length === 500);
        if (controller.signal.aborted) return;
        setDetail(result); setError('');
        if (terminal(result.task.status) && after >= result.task.event_seq) return;
      } catch (e) { if (!controller.signal.aborted) setError(errorText(e)); }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 1500);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, id, revision]);

  async function cancel() {
    setBusy(true);
    try { await api.cancelTask(id); setRevision(v => v + 1); }
    catch (e) { message.error(errorText(e)); }
    finally { setBusy(false); }
  }
  const task = detail?.task;
  return <Drawer open title="任务详情" width={680} onClose={onClose}>
    {error && <Alert type="error" showIcon message={error} action={<Button onClick={() => setRevision(v => v + 1)}>重连</Button>} />}
    {task && <>
      <h3>{task.goal}</h3><Tag color={task.status === 'failed' || task.status === 'interrupted' ? 'error' : 'blue'}>{labels[task.status]}</Tag>
      <p><code>{task.project_root}</code></p>
      <p className="muted">最近活动：{new Date(task.updated_at).toLocaleString()} · {task.agent_id}</p>
      {task.reason && <Alert type="warning" message={'原因：' + task.reason} />}
      {!terminal(task.status) && <Button danger loading={busy} disabled={task.status === 'cancelling'} onClick={() => void cancel()}>取消任务</Button>}
      {task.status === 'interrupted' && task.reason !== 'interruption_acknowledged' && <Button onClick={() => modal.confirm({
        title: '确认没有遗留的执行进程？', content: '请先核查 Harness 及其命令。此操作仅解除后续派发阻塞，不会重跑任务。',
        okText: '已核查，无遗留进程', cancelText: '返回核查', onOk: async () => {
          await api.acknowledgeTask(id); setRevision(v => v + 1);
        },
      })}>核查中断任务</Button>}
      <h4>菜菜汇报</h4><Button loading={reporting} onClick={async () => {
        setReporting(true);
        try { const result = await api.reportTask(id); setReport(result.text); }
        catch (e) { message.error(errorText(e)); }
        finally { setReporting(false); }
      }}>让菜菜汇报</Button>
      <p className="muted">关键节点自动汇报，每类节点最多一次、至少间隔30秒；语音遵循自动朗读开关。也可手动整理最新证据。</p>
      {(report || [...events].reverse().find(e => e.payload.kind === 'caicai_report')) && <pre className="task-output">{report || text([...events].reverse().find(e => e.payload.kind === 'caicai_report')?.payload.message)}</pre>}
      <h4>执行器结果</h4><pre className="task-output">{task.result || '执行器尚未交付结果。'}</pre>
      <h4>检测到的文件改动</h4>
      {detail.artifacts.length ? detail.artifacts.map(a => <p key={a.id}><Tag>{a.kind}</Tag><code>{a.path}</code>
        {a.sha256 && <small className="task-hash">SHA-256 {a.sha256}</small>}</p>) : <p className="muted">尚无已记录的文件改动。</p>}
      <Collapse items={[{ key: 'attempts', label: '执行尝试与运行标识', children: detail.attempts.map(a => <p key={a.id}>
        第 {a.number} 次 · {a.executor_id} {a.executor_version} · {labels[a.status]} · 退出码 {a.exit_code ?? '未知'}<br />
        <code>{a.run_ref || '尚未取得运行标识'}</code></p>) }]} />
    </>}
    <h4>真实步骤与检查记录</h4><p className="muted">步骤来自执行器事件；工具返回不代表测试通过，检查结果见输出。</p>
    {events.map(event => <div className="task-event" key={event.seq}>
      <small>#{event.seq} · {new Date(event.occurred_at).toLocaleTimeString()}</small>
      <div>{eventLabel(event)}</div>
      {event.payload.exit_code !== undefined && <Tag color={event.payload.exit_code === 0 ? 'green' : 'error'}>退出码 {String(event.payload.exit_code)}</Tag>}
      {text(event.payload.output) && <details><summary>查看工具输出</summary><pre className="task-output">{text(event.payload.output)}</pre></details>}
    </div>)}
  </Drawer>;
}

export function TaskCards({ api, conversationId, refreshKey = 0 }: { api: Api; conversationId?: string; refreshKey?: number }) {
  const { tasks, error, refresh } = useTasks(api, conversationId);
  const [selected, setSelected] = useState('');
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => { if (refreshKey) refreshRef.current(); }, [refreshKey]);
  return <div className="task-cards">
    {error && <Alert type="warning" message={error} action={<Button onClick={refresh}>重试</Button>} />}
    {!conversationId && !tasks.length && !error && <Empty description="还没有任务，先登记项目并启用 DeepSeek 插件。" />}
    {tasks.filter(task => !conversationId || !terminal(task.status)).map(task => <Card key={task.id} size="small" title={<Space><Tag color={task.status === 'succeeded' ? 'green' : task.status === 'failed' || task.status === 'interrupted' ? 'error' : 'blue'}>{labels[task.status]}</Tag><span>{task.goal}</span></Space>}
      extra={<Button size="small" onClick={() => setSelected(task.id)}>查看任务</Button>}>
      <div className="muted">{task.project_root} · {new Date(task.updated_at).toLocaleString()}</div>
      {!terminal(task.status) && <p>当前步骤：{task.current_step || labels[task.status]}</p>}
      {task.reason && <p>阻塞 / 结束原因：{task.reason}</p>}
      {task.result && <p className="task-preview">{task.result}</p>}
    </Card>)}
    {selected && <TaskInspector key={selected} api={api} id={selected} onClose={() => { setSelected(''); refresh(); }} />}
  </div>;
}

export function TaskComposer({ api, conversations, conversationId, draft = '', open, onClose, onCreated }: {
  api: Api; conversations: Conversation[]; conversationId?: string; draft?: string; open: boolean;
  onClose: () => void; onCreated: (task: TaskRecord) => void;
}) {
  const [form] = Form.useForm();
  const [projects, setProjects] = useState<TaskProject[]>([]);
  const [plugins, setPlugins] = useState<TaskPlugin[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const pending = useRef({ signature: '', key: '' });
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true); setError('');
    form.setFieldsValue({ conversation_id: conversationId, goal: draft });
    void Promise.all([api.taskProjects(), api.taskPlugins()]).then(([p, plugins]) => {
      if (live) { setProjects(p); setPlugins(plugins); }
    }).catch(e => { if (live) setError(errorText(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [api, open, conversationId, draft, form]);
  const plugin = plugins.find(p => p.manifest.id === 'caicai.deepseek');
  async function submit(values: { conversation_id: string; project_id: string; goal: string }) {
    if (sending) return;
    const payload = { ...values, goal: values.goal.trim() };
    const signature = JSON.stringify(payload);
    if (pending.current.signature !== signature) pending.current = { signature, key: crypto.randomUUID() };
    setSending(true); setError('');
    try {
      const task = await api.createTask({ ...payload, idempotency_key: pending.current.key });
      onCreated(task); pending.current = { signature: '', key: '' }; form.resetFields();
    } catch (e) { setError(errorText(e)); }
    finally { setSending(false); }
  }
  return <Modal open={open} title="交给菜菜执行" footer={null} onCancel={() => !sending && onClose()}
    closable={!sending} maskClosable={!sending}>
    <p className="muted">DeepSeek Harness 使用自身配置的模型与认证。关闭窗口后任务继续，取消请进入任务详情。</p>
    {error && <Alert type="error" message={error} />}
    {!loading && (!plugin?.enabled || !plugin.executor.ready) && <Alert type="warning" message={plugin?.executor.message || '请先在任务中心启用 DeepSeek 插件并登记项目。'} />}
    <Form form={form} layout="vertical" onFinish={submit} disabled={loading || sending}>
      <Form.Item name="conversation_id" label="所属会话" rules={[{ required: true, message: '请选择会话' }]}>
        <Select aria-label="任务所属会话" options={conversations.map(c => ({ label: c.peer_id, value: c.id }))} /></Form.Item>
      <Form.Item name="project_id" label="执行项目" rules={[{ required: true, message: '请选择已登记项目' }]}>
        <Select aria-label="执行项目" placeholder="在任务中心登记项目后选择" options={projects.map(p => ({ value: p.id, label: p.name + ' · ' + p.root }))} /></Form.Item>
      <Form.Item name="goal" label="任务目标与验收条件" rules={[{ required: true, whitespace: true, message: '请填写任务目标' }]}>
        <Input.TextArea aria-label="任务目标与验收条件" rows={5} maxLength={16000} /></Form.Item>
      <Button block type="primary" htmlType="submit" loading={sending || loading}
        onClick={() => void prepareSpeechPlayback().catch(() => {})}
        disabled={!plugin?.enabled || !plugin.executor.ready}>创建后台任务</Button>
    </Form>
  </Modal>;
}

export function TasksPage({ api, conversations, conversationId }: { api: Api; conversations: Conversation[]; conversationId?: string }) {
  const { message, modal } = App.useApp();
  const [picking, setPicking] = useState(false);
  const [runtime, setRuntime] = useState<{ mode: string; state: string }>();
  const [plugins, setPlugins] = useState<TaskPlugin[]>([]);
  const [projects, setProjects] = useState<TaskProject[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [form] = Form.useForm();
  useEffect(() => {
    let live = true;
    void Promise.all([api.taskPlugins(), api.taskProjects(), api.taskRuntime()]).then(([p, r, worker]) => {
      if (live) { setPlugins(p); setProjects(r); setRuntime(worker); setError(''); }
    }).catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [api, revision]);
  async function toggle(plugin: TaskPlugin) {
    setBusy(true);
    try { await api.enableTaskPlugin(plugin.manifest.id, !plugin.enabled); setRevision(v => v + 1); }
    catch (e) { message.error(errorText(e)); }
    finally { setBusy(false); }
  }
  async function pickDirectory() {
    setPicking(true);
    try {
      const root = await selectProjectDirectory();
      if (root) {
        form.setFieldValue('root', root);
        if (!form.getFieldValue('name')?.trim()) form.setFieldValue('name', root.split(/[\\/]/).filter(Boolean).at(-1));
      }
    } catch (e) { message.error(errorText(e)); }
    finally { setPicking(false); }
  }
  function removeProject(project: TaskProject) {
    modal.confirm({ title: '删除项目登记「' + project.name + '」？',
      content: '只移除任务中心的登记，不删除磁盘文件；已有任务历史保留。存在待执行任务时请先取消或等待完成。',
      okText: '删除登记', cancelText: '取消', okButtonProps: { danger: true },
      async onOk() {
        try { await api.deleteTaskProject(project.id); setRevision(v => v + 1); message.success('项目登记已删除'); }
        catch (e) { message.error(errorText(e)); throw e; }
      },
    });
  }
  async function addProject(values: { name: string; root: string }) {
    setBusy(true);
    try { await api.addTaskProject(values.name, values.root); form.resetFields(); setRevision(v => v + 1); }
    catch (e) { message.error(errorText(e)); }
    finally { setBusy(false); }
  }
  return <div className="page-body tasks-page">
    <div className="section-heading"><div><h2>让菜菜把事情做完</h2><p>任务独立运行，进度、结果与文件改动保存在本机。</p></div>
      <Space><Button icon={<ReloadOutlined />} onClick={() => setRevision(v => v + 1)}>刷新配置</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建任务</Button></Space></div>
    {error && <Alert type="error" message={error} />}
    <Collapse items={[{ key: 'config', label: '执行器与项目设置', children: <>
      {plugins.map(plugin => <Card key={plugin.manifest.id} size="small" title={plugin.manifest.name}
        extra={<Button loading={busy} disabled={!plugin.enabled && !plugin.executor.ready} onClick={() => void toggle(plugin)}>{plugin.enabled ? '停用插件' : '启用插件'}</Button>}>
        <Tag color={plugin.executor.ready ? 'green' : 'warning'}>{plugin.executor.ready ? '可用' : '未就绪'}</Tag>
        <Tag>{plugin.enabled ? '已启用' : '未启用'}</Tag><span>{plugin.executor.id} · {plugin.executor.version}</span>
        <p>{plugin.executor.message}</p>{plugin.executor.model_selection && <p>执行模型：{plugin.executor.model_selection.provider} / {plugin.executor.model_selection.model}</p>}
        {plugin.executor.limitations.map(item => <p className="muted compact" key={item}>{item}</p>)}
      </Card>)}
      <h4>已登记的项目目录</h4>{projects.map(p => <p key={p.id}>{p.name} · <code>{p.root}</code>
        <Button type="text" danger size="small" icon={<DeleteOutlined />} aria-label={'删除项目' + p.name}
          onClick={() => removeProject(p)}>删除登记</Button></p>)}
      <Form form={form} layout="vertical" onFinish={addProject} disabled={busy}>
        <Form.Item name="name" label="项目名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={100} /></Form.Item>
        <Form.Item label="项目绝对目录" required extra={isDesktop ? '选择后自动填写绝对路径，也可手动修改。' : '在桌面端可直接选择本机文件夹；网页端请填写后端所在电脑的绝对路径。'}>
          <Space.Compact block><Form.Item name="root" noStyle rules={[{ required: true, whitespace: true }]}>
            <Input aria-label="项目绝对目录" placeholder="选择项目文件夹" /></Form.Item>
            <Button icon={<FolderOpenOutlined />} loading={picking} disabled={!isDesktop} onClick={() => void pickDirectory()}>选择文件夹</Button>
          </Space.Compact></Form.Item>
        <Button htmlType="submit" loading={busy}>登记项目</Button>
      </Form>
    </> }]} defaultActiveKey={['config']} />
    <Alert type={runtime?.state === 'running' ? 'info' : 'warning'} showIcon
      message={runtime?.state === 'running' ? '任务 worker 已运行 · ' + (runtime.mode === 'managed' ? '桌面托管' : '外部服务')
        : '任务 worker 尚未运行。手动启动后端时，请另运行 python -m app.task_worker，再刷新配置。'} />
    <h3>任务历史 · 最近 5 天</h3><p className="muted">已结束任务超过 5 天自动删除执行记录；进行中的任务和中断待核查任务保留。完成后仅一次性语音提醒，播完自动删除音频。</p><TaskCards api={api} refreshKey={revision} />
    <TaskComposer api={api} conversations={conversations} conversationId={conversationId} open={open}
      onClose={() => setOpen(false)} onCreated={() => { setOpen(false); setRevision(v => v + 1); }} />
  </div>;
}
