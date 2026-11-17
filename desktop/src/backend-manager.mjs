import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loopbackUrl } from './policy.mjs';

const messages = {
  port_occupied: '后端端口已被其他服务占用。请释放端口或修改 CAICAI_BACKEND_URL 后重新启动。',
  python_missing: '未找到可执行的 Python 环境。请按 README 安装 backend/.venv，或设置 CAICAI_BACKEND_PYTHON。',
  launcher_missing: '未找到后端启动文件。请检查项目是否完整，并重新构建桌面端。',
  dependencies_missing: '后端 Python 依赖缺失。请在 backend 虚拟环境中安装 README 要求的依赖后重试。',
  config_invalid: '后端配置无效。请检查 backend/.env 中的 ADMIN_TOKEN（本地至少 6 字符，生产环境至少 32 字符）及其他配置后重试。',
  startup_failed: '后端启动失败。请检查后端配置、数据目录权限及数据库是否可用后重试。',
  startup_timeout: '等待后端启动超时。请检查 Python 环境和后端配置后重试。',
  backend_exited: '后端进程已异常退出。修复问题后点击“重试连接 / 启动”；不会自动重发聊天。',
  connection_lost: '后端连接已断开。请检查服务后重试连接；不会自动重发聊天。',
  autostart_disabled: '后端未启动，当前已关闭自动启动。请手动启动后端后重试连接。',
  stop_failed: '后端进程未能停止，请检查进程状态后重新启动菜菜。',
};

// Identity is checked before reusing a port. Never treat an arbitrary HTTP 200 as our API.
export function probeBackend(origin, timeout = 1000) {
  return new Promise(resolveProbe => {
    let done = false;
    const finish = result => {
      if (done) return;
      done = true; clearTimeout(timer); resolveProbe(result);
    };
    const req = request(new URL('/health', origin), { method: 'GET', agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 4096) { finish({ kind: 'occupied' }); req.destroy(); }
      });
      res.on('error', () => finish({ kind: 'occupied' }));
      res.on('end', () => {
        let valid = false;
        try { valid = JSON.parse(body).status === 'ok'; } catch { /* Not the backend. */ }
        finish(res.statusCode === 200 && res.headers['x-caicai-service'] === 'caicai-bot' && valid
          ? { kind: 'ready', instance: res.headers['x-caicai-instance'] } : { kind: 'occupied' });
      });
    });
    const timer = setTimeout(() => { finish({ kind: 'occupied' }); req.destroy(); }, timeout);
    req.on('error', error => finish({ kind: error.code === 'ECONNREFUSED' ? 'offline' : 'occupied' }));
    req.end();
  });
}

export class BackendManager {
  constructor({ origin, backendRoot, python, env = process.env, autoStart = true,
    startupTimeout = 20000, stopTimeout = 8000, pollInterval = 200, monitorInterval = 3000 }) {
    this.origin = loopbackUrl(origin);
    this.backendRoot = resolve(backendRoot);
    this.python = python ? resolve(python) : join(this.backendRoot, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
    this.env = env; this.autoStart = autoStart;
    this.startupTimeout = startupTimeout; this.stopTimeout = stopTimeout; this.pollInterval = pollInterval;
    this.state = 'stopped'; this.mode = null; this.error = null; this.child = null;
    this.closed = false; this.operation = null; this.termination = null;
    this.monitor = setInterval(() => { void this.check(); }, monitorInterval);
    this.monitor.unref();
  }

  status() {
    return { state: this.state, mode: this.mode, owned: Boolean(this.child), error: this.error };
  }

  fail(code) { this.state = 'failed'; this.error = { code, message: messages[code] }; }

  start() {
    if (this.closed) return Promise.resolve(this.status());
    if (this.operation) return this.operation;
    this.state = 'connecting'; this.error = null;
    this.operation = this.ensure().catch(() => { if (!this.closed) this.fail('startup_failed'); })
      .then(() => this.status()).finally(() => { this.operation = null; });
    return this.operation;
  }

  async ensure() {
    let health = await probeBackend(this.origin);
    if (this.closed) return;
    if (health.kind === 'ready' && (!this.child || health.instance === this.child.instance)) {
      this.state = 'ready'; this.mode = this.child ? 'managed' : 'external'; return;
    }
    // Explicit retry can replace an unresponsive owned process, never an external process.
    if (this.child) {
      await this.terminateOwned();
      if (this.closed) return;
      health = await probeBackend(this.origin);
      if (health.kind === 'ready') { this.state = 'ready'; this.mode = 'external'; return; }
    }
    this.mode = null;
    if (health.kind === 'occupied') { this.fail('port_occupied'); return; }
    if (!this.autoStart) { this.fail('autostart_disabled'); return; }
    try { await access(this.python, constants.X_OK); } catch { this.fail('python_missing'); return; }
    const launcher = join(this.backendRoot, 'desktop_server.py');
    try { await access(launcher, constants.R_OK); } catch { this.fail('launcher_missing'); return; }
    if (this.closed) return;
    this.state = 'starting'; this.mode = 'managed';
    const url = new URL(this.origin);
    const instance = randomUUID();
    const env = { ...this.env, CAICAI_DESKTOP_RUN_ID: instance, PYTHONUNBUFFERED: '1' };
    // Electron-specific Python startup hooks and Python path overrides must not alter imports.
    for (const key of ['PYTHONHOME', 'PYTHONPATH', 'ELECTRON_RUN_AS_NODE']) delete env[key];
    const child = spawn(this.python, ['-u', launcher, '--host', url.hostname, '--port', url.port || '80'], {
      cwd: this.backendRoot, env, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    const record = { process: child, instance, exited: false, failure: null };
    this.child = record;
    // Only accept bounded, predefined diagnostic codes; never surface Python tracebacks or secrets.
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending = (pending + chunk).slice(-8192);
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('CAICAI_BACKEND_ERROR=')) continue;
        const code = line.slice('CAICAI_BACKEND_ERROR='.length).trim();
        if (['dependencies_missing', 'config_invalid', 'startup_failed'].includes(code)) record.failure = code;
      }
    });
    child.stdin.on('error', () => {});
    record.finished = new Promise(resolveExit => {
      const finish = () => {
        if (record.exited) return;
        record.exited = true;
        // An abruptly crashed API may leave its own TTS child in the same group.
        this.signal(record, 'SIGKILL');
        if (this.child === record) {
          this.child = null;
          if (!this.closed && this.state !== 'stopping') this.fail(record.failure || 'backend_exited');
        }
        resolveExit();
      };
      child.once('error', () => { record.failure = 'python_missing'; finish(); });
      child.once('exit', finish);
    });
    const deadline = Date.now() + this.startupTimeout;
    while (!this.closed && !record.exited && Date.now() < deadline) {
      health = await probeBackend(this.origin, Math.min(500, this.startupTimeout));
      if (this.closed || record.exited) break;
      if (health.kind === 'ready' && health.instance === instance) { this.state = 'ready'; return; }
      await delay(this.pollInterval);
    }
    const failure = record.failure || (record.exited ? 'backend_exited' : 'startup_timeout');
    await this.terminateOwned();
    if (!this.closed) this.fail(failure);
  }

  async check() {
    if (this.closed || this.operation || this.checking || this.state !== 'ready') return;
    this.checking = true;
    const record = this.child;
    try {
      const health = await probeBackend(this.origin);
      if (!this.closed && !this.operation && this.state === 'ready' && this.child === record
        && (health.kind !== 'ready' || (record && health.instance !== record.instance))) this.fail('connection_lost');
    } finally { this.checking = false; }
  }

  signal(record, signal) {
    if (!record.process.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-record.process.pid, signal);
      else record.process.kill(signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }

  terminateOwned() {
    if (this.termination) return this.termination;
    const record = this.child;
    if (!record) return Promise.resolve();
    this.termination = (async () => {
      record.process.stdin.end();
      this.signal(record, 'SIGTERM');
      let timer;
      await Promise.race([record.finished, new Promise(resolveWait => { timer = setTimeout(resolveWait, this.stopTimeout); })]);
      clearTimeout(timer);
      if (!record.exited) {
        this.signal(record, 'SIGKILL');
        await record.finished;
      }
    })().finally(() => { this.termination = null; });
    return this.termination;
  }

  async stop() {
    this.closed = true; clearInterval(this.monitor); this.state = 'stopping';
    try {
      await this.terminateOwned();
      await this.operation;
      this.state = 'stopped'; this.mode = null; this.error = null;
    } catch { this.fail('stop_failed'); }
    return this.status();
  }
}
