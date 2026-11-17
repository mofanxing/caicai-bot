import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopbackUrl, makeSelectionChanges } from '../src/policy.mjs';

test('本地服务地址只接受无凭据的本机 HTTP origin', () => {
  assert.equal(loopbackUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000');
  assert.equal(loopbackUrl('http://localhost:5173'), 'http://localhost:5173');
  for (const url of ['https://example.com', 'http://192.168.1.5', 'file:///tmp/a', 'http://user:secret@localhost', 'http://localhost/a', 'http://localhost/?token=secret', 'http://localhost/#token=secret']) {
    assert.throws(() => loopbackUrl(url));
  }
});
test('切换形象只修改 display，保留浏览器显示位和角色配置', () => {
  const pets = [{ id: 'a', display: 'both', voice: 'v1' }, { id: 'b', display: 'web', persona: 'hello' }, { id: 'c', display: 'none' }];
  const before = structuredClone(pets);
  assert.deepEqual(makeSelectionChanges(pets, 'b'), [{ id: 'b', display: 'both' }, { id: 'a', display: 'web' }]);
  assert.deepEqual(pets, before);
});
test('目标先显示，已有桌宠再隐藏，支持多个原有实例', () => {
  assert.deepEqual(makeSelectionChanges([{ id: 'a', display: 'desktop' }, { id: 'b', display: 'none' }, { id: 'c', display: 'desktop' }], 'b'), [
    { id: 'b', display: 'desktop' }, { id: 'a', display: 'none' }, { id: 'c', display: 'none' },
  ]);
});
test('重复选择已显示的单个角色不产生写入', () => {
  assert.deepEqual(makeSelectionChanges([{ id: 'a', display: 'desktop' }, { id: 'b', display: 'none' }], 'a'), []);
});
test('无效形象在任何修改发生前拒绝', () => {
  for (const id of [undefined, null, 1, {}, '../escape', 'missing']) assert.throws(() => makeSelectionChanges([{ id: 'a', display: 'desktop' }], id));
});
