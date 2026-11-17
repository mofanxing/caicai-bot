import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { desktopRoot } from './paths.mjs';

// 继承的上游自检即使没有创建动画也会 exit(0)，这里校验实际结果，避免假通过。
const child = spawn(process.execPath, [join(desktopRoot, 'scripts/start.mjs'), '--smoke'], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; process.stdout.write(data); });
const watchdog = setTimeout(() => { child.kill('SIGTERM'); }, 45000);
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => {
  clearTimeout(watchdog);
  const parse = regex => { try { return JSON.parse(output.match(regex)?.[1] || 'null'); } catch { return null; } };
  const pet = parse(/smoke dump:.* => (.+)/);
  const input = parse(/smoke interactive round-trip: (.+)/);
  const panel = parse(/caicai-check. (.+)/);
  const passed = code === 0 && pet?.hasBridge && pet?.debug?.configOk && pet?.sprites > 0
    && !pet?.errorVisible && !pet?.debug?.errors?.length && pet?.videoSrcA?.endsWith('.webm')
    && pet?.menuSmoke?.menuMounted && !pet?.menuSmoke?.threw && pet?.menuSmoke?.errsNew === 0
    && panel?.ui?.options > 0 && panel?.ui?.fragmentCleared && !panel?.ui?.message
    && panel?.unauthenticated === 403 && panel?.crossOrigin === 403 && panel?.unknownPet === 400 && panel?.selection;
  const warnings = [];
  if (input?.interactiveIgnoring !== false || input?.passthroughIgnoring !== true) warnings.push('上游合成事件自检：点击穿透往返断言未通过，需人工回归');
  if (pet?.releaseKeptPosition?.kept !== true) warnings.push('上游合成事件自检：松手位置采样不一致，需人工拖拽回归');
  if (pet?.interactiveFlip?.duringDragForced !== true) warnings.push('上游合成事件自检：拖拽中穿透断言未通过，需人工回归');
  const data = resolve(process.env.CAICAI_DESKTOP_DATA || join(desktopRoot, '.data'));
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(join(data, 'smoke.json'), JSON.stringify({ passed: Boolean(passed), warnings, pet, input, panel }, null, 2), { mode: 0o600 });
  console.log(`菜菜桌宠检查：${passed ? '基础链路通过' : '失败'}；待复核 ${warnings.length} 项。报告：${join(data, 'smoke.json')}`);
  process.exitCode = passed ? 0 : 1;
});
