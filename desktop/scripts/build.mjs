import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { desktopRoot, upstreamRoot, packageRoot, distRoot } from './paths.mjs';

const lock = JSON.parse(readFileSync(join(desktopRoot, 'upstream.lock.json'), 'utf8'));
if (!existsSync(join(packageRoot, 'package.json'))) throw new Error('请先运行 npm run setup');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstreamRoot, encoding: 'utf8' }).trim();
if (head !== lock.commit) throw new Error('缓存版本与 upstream.lock.json 不一致，请运行 npm run setup');
if (execFileSync('git', ['status', '--porcelain'], { cwd: upstreamRoot, encoding: 'utf8' }).trim()) {
  throw new Error('上游缓存存在改动，拒绝构建未经固定的源码');
}
mkdirSync(join(distRoot, 'lib'), { recursive: true });
const frontend = join(desktopRoot, '../frontend');
execFileSync(process.execPath, [join(frontend, 'node_modules/vite/bin/vite.js'), 'build', '--base', '/chat/', '--outDir', join(distRoot, 'chat'), '--emptyOutDir'], { cwd: frontend, stdio: 'inherit' });
for (const item of ['runtime', 'assets']) {
  cpSync(join(packageRoot, item), join(distRoot, item), { recursive: true, filter: source => !source.includes('/assets/preview') });
}
// 只修改构建副本，避免占用上游 dsh-pet 的 Chromium profile。
const helperFile = join(distRoot, 'runtime/electron-helper/main.js');
const helperSource = readFileSync(helperFile, 'utf8');
const userDataLine = "if (APP_MODE) app.setPath('userData', path.join(app.getPath('appData'), 'dsh-pet'));";
if (!helperSource.includes(userDataLine)) throw new Error('上游用户目录逻辑已变化，需人工更新集成');
writeFileSync(helperFile, helperSource.replace(userDataLine, "if (APP_MODE) app.setPath('userData', path.join(process.env.CAICAI_DESKTOP_DATA, 'electron'));"));
// 只在构建副本把原生对话入口接到菜菜，保留点击动画与其他原生菜单。
const menuFile = join(distRoot, 'runtime/electron-helper/sprite/menu.js');
const menuSource = readFileSync(menuFile, 'utf8');
const chatEntry = '  showChatFromMenu(image, encoded) {';
const labels = "const OPEN_LABEL = { desktop: '打开软件', standalone: '打开 AI 设置', web: '打开网站' };";
if (!menuSource.includes(chatEntry) || !menuSource.includes(labels)) throw new Error('上游对话入口已变化，需更新菜菜适配');
writeFileSync(menuFile, menuSource.replace(labels, "const OPEN_LABEL = { desktop: '和菜菜聊天', standalone: '和菜菜聊天', web: '和菜菜聊天' };")
  .replace(chatEntry, chatEntry + '\n    if (window.petBridge) { window.petBridge.openDshSite(ORIGIN); return; }'));
cpSync(join(upstreamRoot, 'LICENSE'), join(distRoot, 'UPSTREAM-LICENSE'));
cpSync(join(desktopRoot, 'THIRD_PARTY_NOTICES.md'), join(distRoot, 'THIRD_PARTY_NOTICES.md'));
cpSync(join(desktopRoot, 'src/control.html'), join(distRoot, 'control.html'));
writeFileSync(join(distRoot, 'package.json'), JSON.stringify({ name: 'caicai-desktop', version: '0.1.0', type: 'module' }));
writeFileSync(join(distRoot, 'upstream.lock.json'), JSON.stringify(lock, null, 2));
const alias = Object.fromEntries(['dsh-home-paths', 'dsh-credentials', 'dsh-llm'].map(name => [
  `@deepseek-ai/${name}`, join(packageRoot, 'src/standalone/shims', `${name}.ts`),
]));
await build({
  entryPoints: [join(packageRoot, 'src/shared/index.ts')],
  outfile: join(distRoot, 'runtime/electron-helper/shared-core.js'),
  bundle: true, platform: 'browser', format: 'iife', globalName: 'PetShared', target: 'es2022',
});
await build({
  entryPoints: { app: join(desktopRoot, 'src/main.mjs'), 'upstream-tools': join(desktopRoot, 'src/upstream-tools.mjs') },
  outdir: join(distRoot, 'lib'), outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  alias, external: ['electron', '@electron/*', '@electron-internal/*', '@andresaya/edge-tts'],
  plugins: [{ name: 'fixed-upstream', setup(builder) {
    builder.onResolve({ filter: /^upstream[/]/ }, args => ({ path: join(packageRoot, args.path.slice('upstream/'.length)) }));
  } }],
});
console.log(`菜菜桌面端已构建（dsh-pet ${lock.commit.slice(0, 12)}）`);
