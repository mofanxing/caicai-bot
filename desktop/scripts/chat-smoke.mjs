import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { desktopRoot } from './paths.mjs';

const data = mkdtempSync(join(tmpdir(), 'caicai-chat-check-'));
const token = randomBytes(32).toString('hex');
const backendRoot = resolve(desktopRoot, '../backend');
const backend = spawn(join(backendRoot, '.venv/bin/python'), [join(desktopRoot, 'tests/chat_backend.py')], {
  cwd: backendRoot, env: { ...process.env, PYTHONPATH: backendRoot, CAICAI_CHAT_CHECK_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
});
let desktop;
let backendOutput = '';
const watchdog = setTimeout(() => { backend.kill('SIGTERM'); desktop?.kill('SIGTERM'); }, 45000);
try {
  const origin = await new Promise((resolveOrigin, reject) => {
    backend.on('error', reject);
    backend.on('exit', () => reject(new Error('隔离验收后端启动失败')));
    backend.stderr.on('data', value => { backendOutput += value; });
    backend.stdout.on('data', value => {
      backendOutput += value;
      const found = backendOutput.match(/CAICAI_TEST_BACKEND=(http:[/][/]127[.]0[.]0[.]1:[0-9]+)/);
      if (found) resolveOrigin(found[1]);
    });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(origin + '/health')).ok; } catch { /* wait for lifespan */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!ready) throw new Error('隔离验收后端未就绪');
  desktop = spawn(process.execPath, [join(desktopRoot, 'scripts/start.mjs')], {
    env: { ...process.env, CAICAI_BACKEND_URL: origin, CAICAI_DESKTOP_DATA: data,
      CAICAI_CHAT_CHECK: '1', CAICAI_CHAT_CHECK_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [desktop.stdout, desktop.stderr]) stream.on('data', value => { output += value; });
  const code = await new Promise((resolveCode, reject) => { desktop.once('error', reject); desktop.once('exit', resolveCode); });
  const results = resolve(process.env.CAICAI_CHAT_CHECK_OUTPUT || join(desktopRoot, '.data'));
  mkdirSync(results, { recursive: true });
  if (code !== 0 || !output.includes('[caicai-chat-check]')) throw new Error(output.slice(-5000));
  if (backend.exitCode !== null || !(await fetch(origin + '/health', { signal: AbortSignal.timeout(1500) })).ok) {
    throw new Error('桌面退出不应停止复用的外部后端');
  }
  for (const name of ['chat-smoke.json', 'chat-smoke.png', 'feedback-smoke.png', 'tasks-smoke.png']) writeFileSync(join(results, name), readFileSync(join(data, name)));
  console.log(readFileSync(join(results, 'chat-smoke.json'), 'utf8'));
  console.log('桌面聊天验收截图：' + join(results, 'chat-smoke.png'));
} catch (error) {
  console.error('桌面聊天验收失败：' + error.message); process.exitCode = 1;
} finally {
  clearTimeout(watchdog); desktop?.kill('SIGTERM'); backend.kill('SIGTERM');
  await new Promise(resolve => { if (backend.exitCode !== null) resolve(); else backend.once('exit', resolve); });
  rmSync(data, { recursive: true, force: true });
}
