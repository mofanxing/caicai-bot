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
  const headers = { 'X-DSH-Pet-Token': token, Authorization: 'Bearer ' + admin };
  const conversations = await (await fetch(origin + '/api/v1/conversations', { headers })).json();
  const conversation = conversations.find(item => item.channel === 'desktop');
  const feedbackUrl = origin + `/api/v1/conversations/${conversation.id}/speech-feedback`;
  const before = await (await fetch(feedbackUrl, { headers })).json();
  assert.equal(before.thinking, null); assert.equal(before.waiting, null, '进入聊天不应自动生成提示语音');
  await evaluate("document.querySelector('[data-feedback-generate]').click()");
  await wait("document.querySelector('[data-feedback-status=ready]') !== null");
  const first = await (await fetch(feedbackUrl, { headers })).json();
  assert.ok(first.thinking?.id && first.waiting?.id);
  await evaluate("document.querySelector('[data-feedback-generate]').click()");
  let regenerated;
  for (let i = 0; i < 100; i++) {
    regenerated = await (await fetch(feedbackUrl, { headers })).json();
    if (regenerated.thinking?.id !== first.thinking.id && regenerated.thinking?.status === 'completed'
      && regenerated.waiting?.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.notEqual(regenerated.thinking?.id, first.thinking.id);
  for (const phase of ['thinking', 'waiting']) {
    const response = await fetch(origin + '/api/v1/speech/jobs/' + first[phase].id + '/audio', { headers });
    assert.equal(response.status, 404, '重新生成必须删除上一版文件和任务');
  }
  await wait("document.querySelector('[data-feedback-status=ready]') !== null");
  // Let the authenticated audio downloads and decode finish before starting the turn.
  await new Promise(resolve => setTimeout(resolve, 200));
  await evaluate(`{
    window.__caicaiPlaybackDurations = [];
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args) {
      window.__caicaiPlaybackDurations.push(this.buffer?.duration || 0);
      return original.apply(this, args);
    };
    void 0;
  }`);
  await evaluate(`{ const input = document.querySelector('textarea[aria-label=聊天内容]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '桌面验收：你好菜菜');
    input.dispatchEvent(new Event('input', { bubbles: true })); }`);
  await wait("document.querySelector('.composer [data-chat-send]')?.disabled === false");
  const bubbleTexts = new Set();
  let sampling = true;
  const sampleBubbles = (async () => {
    while (sampling) {
      try {
        const state = await (await fetch(origin + '/dsh-pet-7340/state', { headers })).json();
        const text = state.pets?.main?.say?.data?.text;
        if (text) bubbleTexts.add(text);
      } catch { /* A later assertion still requires the actual native state observations. */ }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  })();
  await evaluate("document.querySelector('.composer [data-chat-send]').click()");
  await wait("document.querySelector('.message-row.assistant .bubble')?.textContent.includes('桌面链路验收') === true");
  window.close(); assert.equal(window.isDestroyed(), false); assert.equal(window.isVisible(), false);
  await wait("document.querySelector('.speech-progress')?.textContent.includes('朗读完成') === true");
  sampling = false; await sampleBubbles;
  const playbackDurations = await evaluate('window.__caicaiPlaybackDurations');
  const feedbackClips = playbackDurations.filter(duration => Math.abs(duration - 0.75) > 0.01);
  assert.equal(feedbackClips.length, 2, '思考和语音准备各播放一次按配置生成的短句：' + JSON.stringify(playbackDurations));
  assert.ok(feedbackClips.every(duration => duration > 0.3));
  const prepared = await (await fetch(feedbackUrl, { headers })).json();
  assert.equal(prepared.voice_id, conversation.voice_id);
  assert.equal(prepared.style_prompt, '轻快亲切，像朋友一样回应');
  for (const phase of ['thinking', 'waiting']) {
    assert.equal(prepared[phase].voice_id, conversation.voice_id);
    assert.equal(prepared[phase].style_prompt, prepared.style_prompt);
    assert.equal(prepared[phase].status, 'completed');
  }
  const history = await (await fetch(origin + `/api/v1/conversations/${conversation.id}/messages`, { headers })).json();
  assert.equal(history.length, 1); assert.equal(history[0].status, 'completed');
  assert.ok(history[0].speech_job_ids.length > 0);
  const segments = await Promise.all(history[0].speech_job_ids.map(async id =>
    (await fetch(origin + '/api/v1/speech/jobs/' + id, { headers })).json()));
  assert.ok(segments.length >= 2, '验收必须覆盖多段语音');
  for (const segment of segments) {
    assert.ok(bubbleTexts.has(segment.text), '原生桌宠气泡未显示对应语音段：' + segment.text);
  }
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
  window.showInactive();
  await evaluate("document.querySelector('.feedback-settings').scrollIntoView({ block: 'center', behavior: 'instant' })");
  await new Promise(resolve => setTimeout(resolve, 250));
  const settingsPicture = await window.webContents.capturePage();
  writeFileSync(join(data, 'feedback-smoke.png'), settingsPicture.toPNG());
  window.close(); assert.equal(window.isDestroyed(), false); assert.equal(window.isVisible(), false);
  assert.equal(showChat(false), window);
  assert.equal(await evaluate("document.querySelector('.message-row.assistant .bubble')?.textContent.includes('桌面链路验收')"), true);
  await evaluate("document.querySelector('[aria-label=任务中心]').click()");
  await wait("document.querySelector('.tasks-page') !== null");
  await wait("document.querySelectorAll('.tasks-page .ant-card').length >= 2 && document.querySelector('.tasks-page .ant-card')?.parentElement.textContent.includes('DeepSeek') === true");
  await evaluate("document.querySelector('.tasks-page').scrollIntoView({ block: 'start', behavior: 'instant' })");
  await new Promise(resolve => setTimeout(resolve, 200));
  const tasksPicture = await window.webContents.capturePage();
  writeFileSync(join(data, 'tasks-smoke.png'), tasksPicture.toPNG());
  assert.deepEqual(errors, []);
  const result = { passed: true, channel: conversation.channel, messages: history.length, speechSegments: history[0].speech_job_ids.length,
    phases: [...chatPhases], animationPlayback: receipt.status, closeHidesWindow: true, rendererErrors: errors.length,
    nativeBubbleSegments: segments.length,
    configuredVoiceFeedbackClips: feedbackClips.length, manualRegenerationDeletesPrevious: true, taskCenterVisible: true };
  writeFileSync(join(data, 'chat-smoke.json'), JSON.stringify(result, null, 2));
  console.log('[caicai-chat-check] ' + JSON.stringify(result));
}
