import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { desktopRoot } from './paths.mjs';

const data = mkdtempSync(join(tmpdir(), 'caicai-voice-check-'));
const token = randomBytes(32).toString('hex');
const backendRoot = resolve(desktopRoot, '../backend');
const python = join(backendRoot, '.venv/bin/python');
const source = join(data, 'source.aiff');
const input = join(data, 'input.wav');
const audio = join(data, 'microphone.wav');
let backend; let desktop;
const watchdog = setTimeout(() => { desktop?.kill('SIGTERM'); backend?.kill('SIGTERM'); }, 60000);
try {
  execFileSync('say', ['-v', 'Tingting', '-o', source, '菜菜，告诉我现在几点。']);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', source, input]);
  const padAudio = [
    'import sys,wave',
    "with wave.open(sys.argv[1],'rb') as source:",
    '    frames=source.readframes(source.getnframes())',
    "with wave.open(sys.argv[2],'wb') as target:",
    '    target.setnchannels(1); target.setsampwidth(2); target.setframerate(16000)',
    '    target.writeframes(bytes(2)*16000 + frames + bytes(2)*(16000*25))',
  ].join('\n');
  execFileSync(python, ['-c', padAudio, input, audio]);
  backend = spawn(python, [join(desktopRoot, 'tests/chat_backend.py')], {
    cwd: backendRoot, env: { ...process.env, PYTHONPATH: backendRoot, CAICAI_CHAT_CHECK_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let backendOutput = '';
  const origin = await new Promise((resolveOrigin, reject) => {
    backend.on('error', reject); backend.on('exit', () => reject(new Error('隔离后端提前退出')));
    const read = value => {
      backendOutput += value;
      const match = backendOutput.match(/CAICAI_TEST_BACKEND=(http:[/][/]127[.]0[.]0[.]1:[0-9]+)/);
      if (match) resolveOrigin(match[1]);
    };
    backend.stdout.on('data', read); backend.stderr.on('data', read);
  });
  for (let index = 0; index < 100; index++) {
    try { if ((await fetch(origin + '/health')).ok) break; } catch { /* wait for startup */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  desktop = spawn(process.execPath, [join(desktopRoot, 'scripts/start.mjs')], {
    env: { ...process.env, CAICAI_BACKEND_URL: origin, CAICAI_DESKTOP_DATA: data,
      CAICAI_VOICE_CHECK: '1', CAICAI_VOICE_CHECK_AUDIO: audio, CAICAI_CHAT_CHECK_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [desktop.stdout, desktop.stderr]) stream.on('data', value => { output += value; });
  const code = await new Promise((done, reject) => { desktop.on('error', reject); desktop.on('exit', done); });
  if (code !== 0 || !output.includes('[caicai-voice-check]')) throw new Error(output.slice(-7000));
  const results = join(desktopRoot, '.data'); mkdirSync(results, { recursive: true });
  for (const name of ['voice-chat-smoke.json', 'voice-chat-smoke.png']) cpSync(join(data, name), join(results, name));
  console.log(output.split('\n').find(line => line.includes('[caicai-voice-check]')));
  console.log('语音聊天验收截图：' + join(results, 'voice-chat-smoke.png'));
} catch (error) { console.error('语音验收失败：' + error.message); process.exitCode = 1; }
finally {
  clearTimeout(watchdog); desktop?.kill('SIGTERM'); backend?.kill('SIGTERM');
  if (backend && backend.exitCode === null) await new Promise(resolve => backend.once('exit', resolve));
  rmSync(data, { recursive: true, force: true });
}
