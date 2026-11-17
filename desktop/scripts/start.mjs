import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { desktopRoot, distRoot } from './paths.mjs';

const executable = process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron';
const electron = [process.env.CAICAI_ELECTRON_PATH, process.env.DSH_PET_ELECTRON_PATH, join(homedir(), '.dsh/electron', executable)].find(p => p && existsSync(p));
if (!electron) throw new Error('未找到 Electron。安装 Electron 43.3.0 后设置 CAICAI_ELECTRON_PATH 为可执行文件路径。');
const entry = join(distRoot, 'lib/app.mjs');
if (!existsSync(entry)) throw new Error('请先运行 npm run build');
const data = resolve(process.env.CAICAI_DESKTOP_DATA || join(desktopRoot, '.data'));
mkdirSync(data, { recursive: true, mode: 0o700 });
const env = { ...process.env, CAICAI_DESKTOP_DATA: data, DSH_HOME: join(data, 'dsh') };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes('--smoke')) {
  env.DSH_PET_SMOKE = '1';
  env.DSH_PET_SMOKE_OUT = join(data, 'smoke.png');
}
const child = spawn(electron, [entry], { cwd: desktopRoot, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
child.on('error', () => { console.error('Electron 启动失败，请检查 CAICAI_ELECTRON_PATH'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
