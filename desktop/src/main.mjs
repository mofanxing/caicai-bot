import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apply } from 'upstream/src/host/index.ts';
import { readAllConfig, flattenPetList } from 'upstream/src/host/config.ts';
import { createStandaloneContext } from 'upstream/src/standalone/context.ts';
import { configPathsFor } from 'upstream/src/standalone/options.ts';
import { createRequestSecurity, secureResponse } from 'upstream/src/standalone/request-security.ts';
import { installDesktopAuth } from 'upstream/src/app/desktop-auth.ts';
import { loopbackUrl, makeSelectionChanges } from './policy.mjs';
import { proxyBackend } from './backend-proxy.mjs';
import { chatPresentation, validateChatState } from './chat-state.mjs';
import { checkDesktopChat } from './chat-check.mjs';
import { BackendManager } from './backend-manager.mjs';
import { checkBackendLifecycle } from './backend-check.mjs';

const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, session, shell, dialog } = require('electron');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = process.env.CAICAI_DESKTOP_DATA;
if (!data || !process.env.DSH_HOME) throw new Error('请通过 npm start 启动菜菜桌面端');
const workbench = loopbackUrl(process.env.CAICAI_WORKBENCH_URL || 'http://127.0.0.1:5173');
const backend = loopbackUrl(process.env.CAICAI_BACKEND_URL || 'http://127.0.0.1:8000');
app.setName('菜菜桌宠');
mkdirSync(join(data, 'electron'), { recursive: true, mode: 0o700 });
app.setPath('userData', join(data, 'electron'));
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  try { await boot(); } catch (error) {
    console.error('[caicai-desktop] 启动失败：', error.message);
    void app.whenReady().then(() => { dialog.showErrorBox('菜菜桌宠启动失败', error.message); app.exit(1); });
  }
}

async function boot() {
  const paths = configPathsFor(root, process.env.DSH_HOME);
  mkdirSync(dirname(paths.userFile), { recursive: true, mode: 0o700 });
  if (!existsSync(paths.userFile) && !existsSync(paths.legacyUserFile)) {
    const defaults = readAllConfig(paths).main;
    writeFileSync(paths.userFile, JSON.stringify({
      pets: defaults.pets.map((pet, i) => ({ ...pet, name: i ? pet.name : '菜菜 · 大肥鱼', display: i ? 'none' : 'desktop', balanceEnabled: false, whisperEnabled: false, workStatusEnabled: false })),
      trayEnabled: true, voiceEnabled: false, clickSoundEnabled: true,
      whisperEnabled: false, sleepTalkEnabled: false,
    }, null, 2), { flag: 'wx', mode: 0o600 });
  }
  const security = createRequestSecurity();
  const routes = [];
  let port;
  let control;
  let chat;
  let quitting = false;
  let cleanup;
  let cleanupDone = false;
  const backendManager = new BackendManager({
    origin: backend, backendRoot: resolve(root, '../../backend'),
    python: process.env.CAICAI_BACKEND_PYTHON,
    autoStart: process.env.CAICAI_BACKEND_AUTOSTART !== '0',
  });
  async function shutdown(code) {
    quitting = true;
    cleanup ??= backendManager.stop().finally(() => {
      server.closeAllConnections(); server.close();
      void context.dispose(); cleanupDone = true;
    });
    await cleanup;
    if (code === undefined) app.quit();
    else app.exit(code);
  }
  let chatState = { thinking: false, speaking: false, waiting: false };
  const chatPhases = new Set();
  let presentation = Promise.resolve();
  let presentationVersion = 0;
  const presented = new Map();
  let selecting = false;
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, message => {
    if (level !== 'debug') console[level === 'info' ? 'log' : level](`[caicai-desktop] ${message}`);
  }]));
  const context = createStandaloneContext({ port: () => port, logger, routes, shutdown: () => app.quit() });
  const html = readFileSync(join(root, 'control.html'));
  const prefix = '/dsh-pet-7340';
  const pets = () => flattenPetList(readAllConfig(paths));
  const origin = () => `http://127.0.0.1:${port}`;
  const api = async (path, body) => {
    const response = await fetch(origin() + prefix + path, {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Pet-Token': security.token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error('角色显示设置失败，请重新打开控制面板');
    return result;
  };
  function presentChatState(force = false) {
    const version = ++presentationVersion;
    presentation = presentation.catch(() => {}).then(async () => {
      if (version !== presentationVersion) return;
      const merged = readAllConfig(paths);
      for (const conf of Object.values(merged)) for (const pet of conf.pets) {
        if (!['desktop', 'both'].includes(pet.display)) continue;
        const view = chatPresentation(chatState, conf.animations);
        const previous = presented.get(pet.id);
        if (!force && previous?.phase === view.phase && previous?.text === view.text) continue;
        const suffix = '?pet=' + encodeURIComponent(pet.id) + '&surface=desktop';
        try {
          if (view.animation && (force || previous?.phase !== view.phase)) await api('/anim' + suffix, { name: view.animation });
          if (version !== presentationVersion) return;
          if (view.text) await api('/broadcast' + suffix, { text: view.text, anim: false, speak: false, duration: 240000 });
          else await api('/bubble/clear' + suffix, {});
          presented.set(pet.id, view);
        } catch { /* 睡眠或交互占用期间尊重原生门禁，不打断聊天。 */ }
      }
    });
    return presentation;
  }
  const server = createServer((req, res) => { void handle(req, res).catch(error => {
    logger.warn('本机请求失败：' + error.message);
    if (!res.headersSent) json(res, 500, { error: '操作失败，请重试或查看终端日志' });
    else res.end();
  }); });
  async function handle(req, res) {
    const url = new URL(req.url || '/', origin());
    secureResponse(res, url.pathname);
    if (!security.authorize(req, res, url.pathname.startsWith(prefix + '/'))) return;
    if (url.pathname.startsWith('/api/v1/')) {
      proxyBackend(req, res, backend, url.pathname); return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/chat/')) {
      const directory = join(root, 'chat');
      const file = resolve(directory, decodeURIComponent(url.pathname.slice('/chat/'.length)) || 'index.html');
      if (!file.startsWith(directory + sep) || !existsSync(file) || !statSync(file).isFile()) {
        json(res, 404, { error: '聊天页面不存在，请重新构建桌面端' }); return;
      }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file)); return;
    }
    if (url.pathname === '/favicon.svg' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end(readFileSync(join(root, 'chat/favicon.svg'))); return;
    }
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return;
    }
    if (url.pathname === '/health' && req.method === 'GET') { json(res, 200, { app: 'caicai-desktop', upstream: '0.4.9' }); return; }
    if (url.pathname === '/caicai/status' && req.method === 'GET') {
      const backendStatus = backendManager.status();
      const backendReady = backendStatus.state === 'ready';
      const merged = readAllConfig(paths);
      json(res, 200, { backendReady, backendStatus, workbench, backend, data,
        pets: Object.entries(merged).flatMap(([entry, conf]) => conf.pets.map(p => ({ id: p.id, name: p.name, entry, display: p.display }))),
        chatReady: backendReady, chatState: chatPresentation(chatState).phase,
      }); return;
    }
    if (url.pathname === '/caicai/backend/retry' && req.method === 'POST') {
      if (quitting) { json(res, 409, { error: '菜菜正在退出' }); return; }
      void backendManager.start();
      json(res, 202, { ok: true, backendStatus: backendManager.status() }); return;
    }
    if (url.pathname === '/caicai/select' && req.method === 'POST') {
      if (selecting) { json(res, 409, { error: '正在切换角色，请稍后重试' }); return; }
      selecting = true;
      let before = [];
      let changes = [];
      try {
        before = pets();
        const body = await readJson(req);
        changes = makeSelectionChanges(before, body.id);
        for (const change of changes) await api('/pet-display', change);
        void presentChatState(true);
        json(res, 200, { ok: true });
      } catch (error) {
        for (const p of before) {
          if (changes.some(c => c.id === p.id)) await api('/pet-display', { id: p.id, display: p.display }).catch(() => {});
        }
        json(res, 400, { error: error.message });
      } finally { selecting = false; }
      return;
    }
    if (url.pathname === '/caicai/workbench' && req.method === 'POST') {
      await shell.openExternal(workbench); json(res, 200, { ok: true }); return;
    }
    if (url.pathname === '/caicai/chat' && req.method === 'POST') {
      showChat(); json(res, 200, { ok: true }); return;
    }
    if (url.pathname === '/caicai/control' && req.method === 'POST') {
      showControl(); json(res, 200, { ok: true }); return;
    }
    if (url.pathname === '/caicai/chat-state' && req.method === 'POST') {
      try { chatState = validateChatState(await readJson(req)); }
      catch { json(res, 400, { error: '无效的聊天状态' }); return; }
      if (process.env.CAICAI_CHAT_CHECK === '1') chatPhases.add(chatPresentation(chatState).phase);
      void presentChatState(); json(res, 200, { ok: true }); return;
    }
    if (url.pathname === prefix + '/chat' && req.method === 'POST') {
      showChat();
      json(res, 200, { ok: false, reason: 'unsupported', message: '已打开菜菜聊天窗口，请在窗口中继续输入。' }); return;
    }
    const route = routes.find(route => route.kind === 'exact' ? url.pathname === route.path : url.pathname === route.path || url.pathname.startsWith(route.path + '/'));
    if (route) { await route.handler(req, res); return; }
    json(res, 404, { error: '接口不存在' });
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  process.env.DSH_PET_IN_PROCESS = '1';
  process.env.DSH_PET_APP_MODE = '1';
  process.env.DSH_PET_OPEN_TARGET = 'site';
  process.env.DSH_PET_CONFIG_URL = origin() + prefix + '/config';
  process.env.DSH_PET_SITE_URL = origin();
  process.env.DSH_PET_SCALE = '1';
  delete process.env.DSH_PET_HOST_PID;
  apply(context.ctx);
  if (context.failures.length) {
    await backendManager.stop(); server.close(); void context.dispose();
    throw new Error('上游初始化失败：' + context.failures.join('; '));
  }
  process.env.DSH_PET_PETS = JSON.stringify(pets().filter(p => ['desktop', 'both'].includes(p.display)).map(p => ({ id: p.id, size: p.size })));
  const renderer = join(root, 'runtime/electron-helper/index.html');
  function showChat(visible = true) {
    if (chat && !chat.isDestroyed()) { if (visible) { chat.show(); chat.focus(); } return chat; }
    chat = new BrowserWindow({ title: '菜菜 · 和我聊聊', show: visible, width: 1120, height: 800, minWidth: 760, minHeight: 600,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'caicai-chat', backgroundThrottling: false },
    });
    chat.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    chat.webContents.on('will-navigate', (event, target) => {
      if (new URL(target).origin !== origin() || !new URL(target).pathname.startsWith('/chat/')) event.preventDefault();
    });
    chat.on('close', event => { if (!quitting) { event.preventDefault(); chat.hide(); } });
    chat.webContents.on('render-process-gone', () => { chatState = validateChatState({}); void presentChatState(); });
    void chat.loadURL(origin() + '/chat/#token=' + security.token, { extraHeaders: 'X-DSH-Pet-Token: ' + security.token });
    return chat;
  }
  const showControl = (visible = true) => {
    if (control && !control.isDestroyed()) { control.show(); control.focus(); return; }
    control = new BrowserWindow({ title: '菜菜 · 桌宠控制面板', show: visible, width: 680, height: 800, minWidth: 480, minHeight: 480,
      // 与 file:// 桌宠分开：上游默认 session 会剥除非桌宠页面的能力令牌。
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'caicai-control' },
    });
    control.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    control.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== origin()) event.preventDefault(); });
    void control.loadURL(origin() + '/#token=' + security.token);
    return control;
  };
  void app.whenReady().then(() => {
    installDesktopAuth(session.defaultSession, origin(), renderer, security.token);
  });
  process.env.DSH_PET_APP_TOKEN = security.token;
  try { require(join(root, 'runtime/electron-helper/main.js')); } finally { delete process.env.DSH_PET_APP_TOKEN; }
  app.on('second-instance', () => showChat());
  app.on('activate', () => showChat());
  app.on('before-quit', event => {
    quitting = true;
    if (!cleanupDone) { event.preventDefault(); void shutdown(); }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown(0); });
  // Start asynchronously so a missing Python environment cannot block the pet or settings.
  void backendManager.start();
  // Electron 在 ESM 主模块求值完成后才发 ready；不能在顶层 await 的 boot 内等待 ready。
  void app.whenReady().then(() => {
    // 上游在 ready 回调注册 IPC，必须等其注册完再替换唯一的工作台入口。
    ipcMain.removeAllListeners('pet:open-site');
    ipcMain.on('pet:open-site', event => {
      if (event.sender.getURL().split(/[?#]/)[0] === pathToFileURL(renderer).href) showChat();
    });
    console.log(`[caicai-desktop] 已启动 ${origin()}（仅本机；收起窗口后桌宠继续运行）`);
    if (process.env.CAICAI_BACKEND_CHECK) {
      void checkBackendLifecycle({ showControl, showChat, origin: origin(), token: security.token, data, manager: backendManager })
        .then(() => app.quit()).catch(error => { logger.error('后端验收失败：' + error.message); void shutdown(1); });
    } else if (process.env.CAICAI_CHAT_CHECK === '1') {
      void checkDesktopChat({ showChat, origin: origin(), token: security.token, data, chatPhases })
        .then(() => shutdown(0)).catch(error => { logger.error('聊天验收失败：' + error.message); void shutdown(1); });
    } else if (process.env.DSH_PET_SMOKE !== '1') showControl();
    else void runChecks().catch(() => { console.error('[caicai-check] 检查失败'); void shutdown(1); });
  });
  async function runChecks() {
    const check = showControl(false);
    await new Promise(resolve => check.webContents.once('did-finish-load', resolve));
    // 等候面板自己的状态请求完成，包含未启动后端时的 1.5 秒超时。
    for (let i = 0; i < 60; i++) {
      if (await check.webContents.executeJavaScript("document.querySelectorAll('#pets option').length > 0")) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const ui = await check.webContents.executeJavaScript(`({
      title: document.title, options: document.querySelectorAll('#pets option').length,
      fragmentCleared: location.hash === '', backend: document.getElementById('backend').textContent,
      message: document.getElementById('message').textContent,
    })`);
    const unauthenticated = (await fetch(origin() + '/caicai/status')).status;
    const crossOrigin = (await fetch(origin() + '/caicai/status', { headers: { Origin: 'https://example.com', 'X-DSH-Pet-Token': security.token } })).status;
    const unknownPet = await fetch(origin() + '/caicai/select', { method: 'POST',
      headers: { 'X-DSH-Pet-Token': security.token, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'does-not-exist' }),
    });
    await unknownPet.text();
    const selected = pets().filter(p => ['desktop', 'both'].includes(p.display));
    let selection = false;
    if (selected.length === 1) {
      const response = await fetch(origin() + '/caicai/select', { method: 'POST',
        headers: { 'X-DSH-Pet-Token': security.token, 'content-type': 'application/json' }, body: JSON.stringify({ id: selected[0].id }),
      });
      selection = response.ok && (await response.json()).ok;
    }
    const picture = await check.webContents.capturePage();
    writeFileSync(join(data, 'control.png'), picture.toPNG());
    const result = { ui, unauthenticated, crossOrigin, unknownPet: unknownPet.status, selection };
    console.log('[caicai-check] ' + JSON.stringify(result));
    check.close();
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new Error('请求过大'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('请求必须是 JSON'); }
}
