import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { allowedBackendPath, proxyBackend } from '../src/backend-proxy.mjs';

test('代理仅允许明确的桌面 API 路径和方法', () => {
  assert.equal(allowedBackendPath('/api/v1/desktop/conversations/c1/messages/stream', 'POST'), true);
  for (const path of ['/api/v1/debug/conversations/c1/messages', '/api/v1/channels/wechat-personal/inbound', '/api/v1/../health', '/api/v1/providers/p1/key?target=x']) {
    assert.equal(allowedBackendPath(path, 'POST'), false);
  }
  assert.equal(allowedBackendPath('/api/v1/providers', 'PATCH'), false);
  assert.equal(allowedBackendPath('/api/v1/conversations/c1/speech-feedback', 'POST'), true);
  assert.equal(allowedBackendPath('/api/v1/conversations/c1/speech-feedback', 'GET'), true);
});

test('真实 HTTP 代理及时转发 SSE、保留二进制，并隔离本机凭据', async t => {
  let incoming;
  const backend = createServer((req, res) => {
    incoming = req.headers;
    if (req.url.endsWith('/audio')) { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(Buffer.from([0, 255, 128, 1])); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'private=backend', 'access-control-allow-origin': '*' });
    res.write('data: {"type":"delta","text":"你好"}\n\n');
    setTimeout(() => res.end('data: {"type":"done"}\n\n'), 150);
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const proxy = createServer((req, res) => proxyBackend(req, res, `http://127.0.0.1:${backend.address().port}`, req.url));
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); backend.closeAllConnections(); backend.close(); });
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const response = await fetch(origin + '/api/v1/desktop/conversations/c1/messages/stream', {
    method: 'POST', headers: { authorization: 'Bearer admin-test', 'X-DSH-Pet-Token': 'pet-private', Cookie: 'pet=cookie' }, body: '{}',
  });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /你好/); assert.doesNotMatch(first, /done/);
  assert.equal(incoming.authorization, 'Bearer admin-test');
  assert.equal(incoming.cookie, undefined); assert.equal(incoming['x-dsh-pet-token'], undefined);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.match(new TextDecoder().decode((await reader.read()).value), /done/);
  await reader.cancel();
  const audio = await fetch(origin + '/api/v1/speech/jobs/j1/audio');
  assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [0, 255, 128, 1]);
});

test('后端离线时返回可理解的错误，不暴露网络细节', async t => {
  const closed = createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening');
  const port = closed.address().port; await new Promise(resolve => closed.close(resolve));
  const proxy = createServer((req, res) => proxyBackend(req, res, `http://127.0.0.1:${port}`, req.url));
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/api/v1/capabilities`);
  assert.equal(response.status, 502); assert.match((await response.json()).error.message, /重试连接.*启动后端/);
});
