import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { desktopRoot } from './paths.mjs';
import { probeBackend } from '../src/backend-manager.mjs';

const results = [];
const outputRoot = resolve(process.env.CAICAI_BACKEND_CHECK_OUTPUT || join(desktopRoot, '.data'));
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
for (const scenario of ['managed', 'python_missing']) {
  const data = mkdtempSync(join(tmpdir(), 'caicai-backend-check-'));
  const portServer = createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const origin = `http://127.0.0.1:${portServer.address().port}`;
  await new Promise(resolveClose => portServer.close(resolveClose));
  let output = '';
  const child = spawn(process.execPath, [join(desktopRoot, 'scripts/start.mjs')], {
    cwd: desktopRoot, env: { ...process.env, CAICAI_DESKTOP_DATA: data, CAICAI_BACKEND_URL: origin,
      CAICAI_BACKEND_AUTOSTART: '1', CAICAI_BACKEND_CHECK: scenario,
      CAICAI_BACKEND_PYTHON: scenario === 'managed' ? resolve(desktopRoot, '../backend/.venv/bin/python') : join(data, 'missing-python'),
      APP_ENV: 'test', ADMIN_TOKEN: randomBytes(32).toString('hex'), MOCK_LLM_ENABLED: 'false',
      DATABASE_URL: `sqlite:///${join(data, 'backend.db')}`, SPEECH_DATA_DIR: join(data, 'speech'),
      PROVIDER_ENCRYPTION_KEY: '', PROVIDER_ENCRYPTION_KEY_FILE: join(data, 'provider.key'),
      LOCAL_TTS_PYTHON: join(data, 'no-tts'), LOCAL_TTS_MODEL_DIR: join(data, 'no-model'),
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-32000); });
  const watchdog = setTimeout(() => child.kill('SIGTERM'), 40000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output.slice(-4000));
    const result = JSON.parse(output.match(/\[caicai-backend-check\] (.+)/)?.[1] || 'null');
    assert.equal(result?.passed, true, output.slice(-4000));
    assert.equal((await probeBackend(origin)).kind, 'offline', '退出 Electron 必须完成后端清理');
    result.backendStoppedOnQuit = true; results.push(result);
    const name = 'backend-' + scenario + '.png';
    writeFileSync(join(outputRoot, name), readFileSync(join(data, name)));
    console.log('后端生命周期验收：' + scenario + ' 通过');
  } catch (error) {
    console.error('后端生命周期验收失败：' + error.message); process.exitCode = 1; break;
  } finally {
    clearTimeout(watchdog); child.kill('SIGTERM'); rmSync(data, { recursive: true, force: true });
  }
}
writeFileSync(join(outputRoot, 'backend-smoke.json'), JSON.stringify({ passed: results.length === 2, results }, null, 2), { mode: 0o600 });
