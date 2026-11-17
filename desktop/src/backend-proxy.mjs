import { request } from 'node:http';

// Fixed local origin and an explicit API surface; never forward cookies or pet credentials.
export function allowedBackendPath(path, method) {
  const id = '[a-zA-Z0-9_-]+';
  const rules = [
    ['GET', '^/api/v1/(capabilities|providers|conversations|voices|speech/status|speech/jobs)$'],
    ['POST', '^/api/v1/(providers|conversations|voices)$'],
    ['GET', `^/api/v1/providers/${id}/models$`],
    ['PUT', `^/api/v1/providers/${id}/key$`],
    ['DELETE', `^/api/v1/(providers|conversations|voices)/${id}$`],
    ['PUT', `^/api/v1/conversations/${id}/settings$`],
    ['GET|DELETE', `^/api/v1/conversations/${id}/messages$`],
    ['DELETE', `^/api/v1/conversations/${id}/messages/${id}$`],
    ['POST', `^/api/v1/conversations/${id}/messages/${id}/speech$`],
    ['POST', `^/api/v1/desktop/conversations/${id}/messages(?:/stream)?$`],
    ['GET', `^/api/v1/voices/${id}/reference$`],
    ['POST', `^/api/v1/voices/${id}/previews$`],
    ['GET|DELETE', `^/api/v1/speech/jobs/${id}$`],
    ['GET', `^/api/v1/speech/jobs/${id}/audio$`],
    ['POST', `^/api/v1/speech/jobs/${id}/retry$`],
  ];
  return rules.some(([methods, pattern]) => methods.split('|').includes(method) && new RegExp(pattern).test(path));
}

export function proxyBackend(req, res, backend, path) {
  if (!allowedBackendPath(path, req.method)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '桌面接口不存在' } }));
    return;
  }
  let upstreamResponse;
  const fail = (status, message) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message } }));
  };
  const headers = {};
  for (const name of ['authorization', 'content-type']) if (req.headers[name]) headers[name] = req.headers[name];
  const upstream = request(new URL(path, backend), { method: req.method, headers }, response => {
    upstreamResponse = response;
    if (res.destroyed || res.writableEnded) { response.destroy(); return; }
    const responseHeaders = {};
    for (const name of ['content-type', 'content-length', 'x-accel-buffering']) {
      if (response.headers[name]) responseHeaders[name] = response.headers[name];
    }
    res.writeHead(response.statusCode, responseHeaders);
    response.on('error', () => res.destroy());
    response.pipe(res);
  });
  upstream.setTimeout(75000, () => {
    fail(504, '等待后端超时，请刷新聊天记录查看结果，避免重复发送。');
    upstream.destroy();
  });
  upstream.on('error', () => fail(502, '无法连接菜菜后端，请启动后端后重新连接。'));
  let size = 0;
  req.on('data', chunk => {
    size += chunk.length;
    if (size > 11 * 1024 * 1024) {
      req.unpipe(upstream); fail(413, '上传内容过大'); upstream.destroy(); req.resume();
    }
  });
  req.on('error', () => upstream.destroy());
  res.on('close', () => { upstream.destroy(); upstreamResponse?.destroy(); });
  req.pipe(upstream);
}
