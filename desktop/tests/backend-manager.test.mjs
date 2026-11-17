import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BackendManager, probeBackend } from '../src/backend-manager.mjs';

const backendRoot = fileURLToPath(new URL('../../backend', import.meta.url));
const python = join(backendRoot, '.venv/bin/python');

async function waitFor(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(40); }
  assert.fail('等待后端状态超时');
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'caicai-manager-'));
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const origin = `http://127.0.0.1:${listener.address().port}`;
  await new Promise(resolveClose => listener.close(resolveClose));
  const env = { ...process.env, APP_ENV: 'test', ADMIN_TOKEN: 'isolated-desktop-manager-test-token-32-chars',
    MOCK_LLM_ENABLED: 'false', DATABASE_URL: `sqlite:///${join(root, 'test.db')}`,
    SPEECH_DATA_DIR: join(root, 'speech'), PROVIDER_ENCRYPTION_KEY: '',
    PROVIDER_ENCRYPTION_KEY_FILE: join(root, 'provider.key'),
    LOCAL_TTS_PYTHON: join(root, 'no-tts'), LOCAL_TTS_MODEL_DIR: join(root, 'no-model'),
  };
  const manager = new BackendManager({ origin, backendRoot, python, env,
    monitorInterval: 50, pollInterval: 40, ...overrides });
  t.after(async () => { await manager.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, manager, origin, env };
}

async function serve(t, handler) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('健康探测校验身份、响应大小、重定向和超时', async t => {
  for (const scenario of ['unrelated', 'redirect', 'oversized', 'stalled']) {
    const { origin } = await serve(t, (_req, res) => {
      if (scenario === 'stalled') return;
      if (scenario === 'redirect') { res.writeHead(302, { location: '/health' }); res.end(); return; }
      res.writeHead(200, { 'X-Caicai-Service': scenario === 'unrelated' ? 'other' : 'caicai-bot' });
      res.end(scenario === 'oversized' ? 'x'.repeat(5000) : '{"status":"ok"}');
    });
    assert.deepEqual(await probeBackend(origin, 100), { kind: 'occupied' });
  }
});

test('复用既有菜菜服务；缺少本地 Python 也可连接，退出不关闭外部服务', async t => {
  const { origin } = await serve(t, (_req, res) => {
    res.writeHead(200, { 'X-Caicai-Service': 'caicai-bot' }); res.end('{"status":"ok"}');
  });
  const { manager } = await fixture(t, { origin, python: '/not-installed/python' });
  assert.equal((await manager.start()).state, 'ready');
  assert.deepEqual(manager.status(), { state: 'ready', mode: 'external', owned: false, error: null });
  await manager.stop();
  assert.equal((await probeBackend(origin)).kind, 'ready');
});

test('端口被其他服务占用时拒绝启动，不影响占用者', async t => {
  const { origin } = await serve(t, (_req, res) => res.end('{"status":"ok"}'));
  const { manager } = await fixture(t, { origin });
  assert.equal((await manager.start()).error.code, 'port_occupied');
  assert.equal(manager.child, null);
  await manager.stop();
  assert.equal((await fetch(origin)).status, 200);
});

test('缺少 Python 可解释报错；修复后显式重试，重复启动只创建一个进程', async t => {
  const { manager, origin, root } = await fixture(t, { python: '/not-installed/python' });
  assert.equal((await manager.start()).error.code, 'python_missing');
  manager.python = python;
  const first = manager.start();
  assert.equal(manager.start(), first);
  assert.equal((await first).state, 'ready');
  assert.equal(manager.status().mode, 'managed');
  const record = manager.child;
  assert.equal((await probeBackend(origin)).instance, record.instance);
  const response = await fetch(origin + '/api/v1/providers', { headers: { Authorization: 'Bearer ' + manager.env.ADMIN_TOKEN } });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), []);
  assert.ok(resolve(root) !== backendRoot);
  assert.equal((await manager.start()).state, 'ready');
  assert.equal(manager.child, record);
  await manager.stop();
  assert.equal(record.exited, true);
  assert.equal(manager.status().state, 'stopped');
  assert.equal((await probeBackend(origin)).kind, 'offline');
});

test('配置错误只返回白名单诊断，不泄露令牌；修复后可重试', async t => {
  const { manager } = await fixture(t);
  manager.env = { ...manager.env, ADMIN_TOKEN: 'private-short-token' };
  const state = await manager.start();
  assert.equal(state.state, 'failed'); assert.equal(state.error.code, 'config_invalid');
  assert.doesNotMatch(JSON.stringify(state), /private-short-token|Traceback|input_value/);
  assert.equal(manager.child, null);
  manager.env.ADMIN_TOKEN = 'fixed-isolated-admin-token-at-least-32-chars';
  assert.equal((await manager.start()).state, 'ready');
});

test('运行中异常退出被发现，不自动重启，显式重试可恢复', async t => {
  const { manager } = await fixture(t);
  assert.equal((await manager.start()).state, 'ready');
  const first = manager.child; first.process.kill('SIGKILL');
  await waitFor(() => manager.status().state === 'failed');
  assert.equal(manager.status().error.code, 'backend_exited');
  await delay(150); assert.equal(manager.child, null);
  assert.equal((await manager.start()).state, 'ready');
  assert.notEqual(manager.child.instance, first.instance);
});

test('外部后端断连会更新状态，重试连接不隐式重发请求', async t => {
  let requests = 0;
  const { server, origin } = await serve(t, (_req, res) => {
    requests++; res.writeHead(200, { 'X-Caicai-Service': 'caicai-bot' }); res.end('{"status":"ok"}');
  });
  const { manager } = await fixture(t, { origin, autoStart: false });
  await manager.start();
  server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose));
  await waitFor(() => manager.status().state === 'failed');
  assert.equal(manager.status().error.code, 'connection_lost');
  assert.equal((await manager.start()).error.code, 'autostart_disabled');
  assert.ok(requests >= 1);
});

test('启动超时会终止实际进程，启动过程中退出不会留下后端', async t => {
  const { manager, root } = await fixture(t, { startupTimeout: 200, stopTimeout: 100 });
  await writeFile(join(root, 'desktop_server.py'), 'import time\ntime.sleep(60)\n');
  manager.backendRoot = root;
  assert.equal((await manager.start()).error.code, 'startup_timeout');
  assert.equal(manager.child, null);
  const starting = manager.start();
  await waitFor(() => manager.child !== null);
  const record = manager.child;
  await manager.stop(); await starting;
  assert.equal(record.exited, true); assert.equal(manager.status().state, 'stopped');
  assert.equal((await manager.start()).state, 'stopped');
});

test('依赖缺失和启动失败诊断受白名单约束', async t => {
  const { manager, root } = await fixture(t); manager.backendRoot = root;
  for (const code of ['dependencies_missing', 'startup_failed']) {
    await writeFile(join(root, 'desktop_server.py'), `print('CAICAI_BACKEND_ERROR=${code}', flush=True)\n`);
    assert.equal((await manager.start()).error.code, code); assert.equal(manager.child, null);
  }
});

test('拒绝正常退出的自有后端及其子进程会被强制回收', { skip: process.platform === 'win32' }, async t => {
  const { manager, root } = await fixture(t, { startupTimeout: 500, stopTimeout: 100 });
  manager.backendRoot = root;
  await writeFile(join(root, 'desktop_server.py'), [
    'import signal, subprocess, sys, time',
    'from pathlib import Path',
    'signal.signal(signal.SIGTERM, signal.SIG_IGN)',
    'child = subprocess.Popen([sys.executable, "-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"])',
    'Path("descendant.pid").write_text(str(child.pid))',
    'time.sleep(60)',
  ].join('\n'));
  const starting = manager.start();
  await waitFor(async () => { try { return Boolean(await readFile(join(root, 'descendant.pid'), 'utf8')); } catch { return false; } });
  const pid = Number(await readFile(join(root, 'descendant.pid'), 'utf8'));
  assert.equal((await starting).error.code, 'startup_timeout');
  assert.equal(manager.child, null);
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
});

test('桌面 stdin 租约断开后，真实后端自行退出', async t => {
  const { manager, origin } = await fixture(t);
  assert.equal((await manager.start()).state, 'ready');
  const record = manager.child;
  // No signal: models an Electron crash closing its OS pipe handles.
  record.process.stdin.end();
  await waitFor(() => record.exited);
  assert.equal((await probeBackend(origin)).kind, 'offline');
});

test('拒绝远端地址，避免桌面后端暴露到网络', () => {
  assert.throws(() => new BackendManager({ origin: 'http://0.0.0.0:8000', backendRoot }), /本地服务地址/);
});
