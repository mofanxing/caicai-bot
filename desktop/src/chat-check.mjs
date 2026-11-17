import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Opt-in integration check against an isolated FastAPI backend. No production credentials.
export async function checkDesktopChat({ showChat, origin, token, data, chatPhases }) {
  const window = showChat(false); window.webContents.setAudioMuted(true);
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message.replace(/Bearer \S+/g, 'Bearer [redacted]'));
  });
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  const wait = async script => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('等待聊天页面超时：' + script.slice(0, 100));
  };
  await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  await wait("document.querySelector('input[type=password]') !== null");
  assert.equal(await evaluate('location.hash'), '');
  const admin = process.env.CAICAI_CHAT_CHECK_TOKEN;
  if (!admin) throw new Error('缺少隔离验收后端令牌');
  await evaluate(`sessionStorage.setItem('caicai.admin-token', ${JSON.stringify(admin)}); location.reload();`);
  await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  await wait("document.querySelector('[aria-label=选择桌面会话]') !== null && document.querySelector('textarea[aria-label=聊天内容]')?.disabled === false");
  await evaluate(`{ const input = document.querySelector('textarea[aria-label=聊天内容]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '桌面验收：你好菜菜');
    input.dispatchEvent(new Event('input', { bubbles: true })); }`);
  await wait("document.querySelector('.composer button')?.disabled === false");
  await evaluate("document.querySelector('.composer button').click()");
  await wait("document.querySelector('.message-row.assistant .bubble')?.textContent.includes('桌面链路验收') === true");
  window.close(); assert.equal(window.isDestroyed(), false); assert.equal(window.isVisible(), false);
  await wait("document.querySelector('.speech-progress')?.textContent.includes('朗读完成') === true");
  const headers = { 'X-DSH-Pet-Token': token, Authorization: 'Bearer ' + admin };
  const conversations = await (await fetch(origin + '/api/v1/conversations', { headers })).json();
  const conversation = conversations.find(item => item.channel === 'desktop');
  const history = await (await fetch(origin + `/api/v1/conversations/${conversation.id}/messages`, { headers })).json();
  assert.equal(history.length, 1); assert.equal(history[0].status, 'completed');
  assert.ok(history[0].speech_job_ids.length > 0);
  for (let i = 0; i < 40 && !chatPhases.has('speaking'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(chatPhases.has('thinking')); assert.ok(chatPhases.has('speaking'));
  const state = await (await fetch(origin + '/dsh-pet-7340/state', { headers })).json();
  const animation = state.pets.main.anim.data;
  assert.ok(animation?.playbackId, '聊天状态应发出原生动画指令');
  let receipt;
  for (let i = 0; i < 60; i++) {
    receipt = await (await fetch(origin + '/dsh-pet-7340/playback/' + animation.playbackId, { headers })).json();
    if (receipt.status !== 'accepted') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(['playing', 'ended'].includes(receipt.status), '动画必须有实际播放回执：' + receipt.status);
  const picture = await window.webContents.capturePage();
  writeFileSync(join(data, 'chat-smoke.png'), picture.toPNG());
  window.close(); assert.equal(window.isDestroyed(), false); assert.equal(window.isVisible(), false);
  assert.equal(showChat(false), window);
  assert.equal(await evaluate("document.querySelector('.message-row.assistant .bubble')?.textContent.includes('桌面链路验收')"), true);
  assert.deepEqual(errors, []);
  const result = { passed: true, channel: conversation.channel, messages: history.length, speechSegments: history[0].speech_job_ids.length,
    phases: [...chatPhases], animationPlayback: receipt.status, closeHidesWindow: true, rendererErrors: errors.length };
  writeFileSync(join(data, 'chat-smoke.json'), JSON.stringify(result, null, 2));
  console.log('[caicai-chat-check] ' + JSON.stringify(result));
}
