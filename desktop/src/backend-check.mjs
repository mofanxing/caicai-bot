import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Real Electron + real, isolated Python service; never reads production credentials.
export async function checkBackendLifecycle({ showControl, showChat, origin, token, data, manager }) {
  const window = showControl(false);
  await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  const expected = process.env.CAICAI_BACKEND_CHECK;
  const headers = { 'X-DSH-Pet-Token': token };
  const status = async () => (await (await fetch(origin + '/caicai/status', { headers })).json()).backendStatus;
  async function wait(predicate) {
    for (let i = 0; i < 500; i++) { if (await predicate()) return; await delay(50); }
    throw new Error('后端生命周期验收超时');
  }
  const evaluate = code => window.webContents.executeJavaScript(code);
  await wait(async () => ['ready', 'failed'].includes((await status()).state));
  let state = await status();
  if (expected === 'managed') {
    assert.equal(state.state, 'ready'); assert.equal(state.mode, 'managed'); assert.equal(state.owned, true);
    const worker = await (await fetch(origin + '/api/v1/task-runtime', { headers: { ...headers, Authorization: 'Bearer ' + process.env.ADMIN_TOKEN } })).json();
    assert.equal(worker.mode, 'managed'); assert.equal(worker.state, 'running');
    const record = manager.child;
    const chat = showChat(false); chat.close();
    assert.equal(chat.isDestroyed(), false); assert.equal(chat.isVisible(), false);
    assert.equal(manager.child, record);
    assert.equal((await status()).state, 'ready');
    await wait(async () => (await evaluate("document.getElementById('backend-detail').textContent")).includes('由菜菜启动'));
  } else {
    assert.equal(state.state, 'failed'); assert.equal(state.error.code, 'python_missing');
    await wait(async () => (await evaluate("document.getElementById('backend-detail').textContent")).includes('Python'));
  }
  const before = manager.child;
  const unauthenticated = (await fetch(origin + '/caicai/backend/retry', { method: 'POST' })).status;
  assert.equal(unauthenticated, 403);
  const crossOrigin = (await fetch(origin + '/caicai/backend/retry', { method: 'POST',
    headers: { ...headers, Origin: 'https://example.com' } })).status;
  assert.equal(crossOrigin, 403);
  // Exercise the actual panel button and its authenticated request.
  await evaluate("document.getElementById('retry').click()");
  await wait(async () => await evaluate("document.getElementById('retry').disabled === false"));
  await wait(() => !manager.operation);
  state = await status();
  assert.equal(manager.child, before);
  assert.equal(state.state, expected === 'managed' ? 'ready' : 'failed');
  await wait(async () => (await evaluate("document.getElementById('backend').textContent"))
    === (expected === 'managed' ? '后端已连接' : '后端连接失败'));
  await evaluate("document.getElementById('backend-detail').scrollIntoView({block:'center'})");
  const ui = await evaluate(`({
    label: document.getElementById('backend').textContent,
    detail: document.getElementById('backend-detail').textContent,
    fragmentCleared: location.hash === '',
    message: document.getElementById('message').textContent,
  })`);
  assert.equal(ui.fragmentCleared, true); assert.equal(ui.message, '');
  writeFileSync(join(data, 'backend-' + expected + '.png'), (await window.webContents.capturePage()).toPNG());
  console.log('[caicai-backend-check] ' + JSON.stringify({ passed: true, scenario: expected, state, ui,
    unauthenticated, crossOrigin, retryPreservesProcess: manager.child === before,
    closeHidesChat: expected === 'managed',
  }));
}
