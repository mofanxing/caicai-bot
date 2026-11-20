import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowChatMicrophone } from '../src/media-policy.mjs';

test('仅本机聊天主页面允许麦克风，不允许摄像头或其他权限', () => {
  const request = { permission: 'media', currentUrl: 'http://127.0.0.1:3999/chat/',
    requestingUrl: 'http://127.0.0.1:3999/chat/', origin: 'http://127.0.0.1:3999',
    mediaTypes: ['audio'], isMainFrame: true };
  assert.equal(allowChatMicrophone(request), true);
  for (const patch of [
    { permission: 'geolocation' }, { permission: 'display-capture' },
    { mediaTypes: ['video'] }, { mediaTypes: ['audio', 'video'] }, { mediaTypes: [] },
    { mediaTypes: ['unknown'] }, { mediaTypes: undefined }, { isMainFrame: false },
    { currentUrl: 'http://127.0.0.1:3999/' }, { currentUrl: 'file:///chat/index.html' },
    { requestingUrl: 'https://example.com/chat/' }, { requestingUrl: 'invalid' },
    { requestingUrl: 'http://127.0.0.1:4999/chat/' },
  ]) assert.equal(allowChatMicrophone({ ...request, ...patch }), false, JSON.stringify(patch));
});
