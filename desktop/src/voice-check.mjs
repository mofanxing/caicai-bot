import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Real Chromium capture/worklet + real local ASR. Fake input and muted fixture replies.
export async function checkVoiceChat({ showChat, origin, token, data }) {
  const window = showChat(false); window.webContents.setAudioMuted(true);
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  const wait = async script => {
    for (let index = 0; index < 300; index++) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('语音界面等待超时：' + await evaluate('document.body.innerText.slice(-2000)'));
  };
  await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  const admin = process.env.CAICAI_CHAT_CHECK_TOKEN;
  assert.ok(admin);
  await evaluate("sessionStorage.setItem('caicai.admin-token', " + JSON.stringify(admin) + '); location.reload();');
  await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  await wait("document.querySelector('[data-voice-toggle]')?.disabled === false");
  const headers = { 'X-DSH-Pet-Token': token, Authorization: 'Bearer ' + admin };
  const status = await (await fetch(origin + '/api/v1/speech/recognition/status', { headers })).json();
  assert.equal(status.available, true, status.detail);
  const conversations = await (await fetch(origin + '/api/v1/conversations', { headers })).json();
  const conversation = conversations.find(item => item.channel === 'desktop');
  await evaluate("globalThis.__voiceCheck = { streams: [] };"
    + 'const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);'
    + 'navigator.mediaDevices.getUserMedia = async options => {'
    + 'const stream = await original(options); globalThis.__voiceCheck.streams.push(stream); return stream;'
    + "}; document.querySelector('[data-voice-toggle]').click();");
  await wait("document.querySelector('[data-voice-toggle]')?.innerText.includes('结束语音聊天')");
  await wait("document.querySelector('.voice-chat-transcript') !== null");
  await wait("document.querySelectorAll('.message-row.assistant').length > 0");
  let history = [];
  for (let index = 0; index < 100; index++) {
    history = await (await fetch(origin + '/api/v1/conversations/' + conversation.id + '/messages', { headers })).json();
    if (history[0]?.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(history.length, 1, '一段语音只发送一轮提问');
  assert.match(history[0].user_text, /告[诉訴]我/);
  assert.doesNotMatch(history[0].user_text, /菜菜|蔡蔡|采采/);
  assert.equal(history[0].status, 'completed');
  const composerVisible = await evaluate("document.querySelector('[data-chat-send]').getBoundingClientRect().bottom <= innerHeight");
  assert.equal(composerVisible, true, '常用窗口尺寸下语音控制和发送按钮均应可见');
  writeFileSync(join(data, 'voice-chat-smoke.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate("document.querySelector('[data-voice-toggle]').click()");
  const released = await evaluate('globalThis.__voiceCheck.streams.every(stream => stream.getTracks().every(track => track.readyState === "ended"))');
  assert.equal(released, true, '结束语音必须释放全部麦克风轨道');
  const cameraDenied = await evaluate('navigator.mediaDevices.getUserMedia({video:true,audio:false}).then(stream => {stream.getTracks().forEach(track=>track.stop());return false;},()=>true)');
  assert.equal(cameraDenied, true, '聊天窗口不应获得摄像头权限');
  await evaluate("document.querySelector('[data-voice-settings]').click()");
  await wait("document.querySelector('input[aria-label=唤醒词]') !== null");
  await evaluate("const input = document.querySelector('input[aria-label=唤醒词]');"
    + "Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '小助手');"
    + "input.dispatchEvent(new Event('input', {bubbles:true}));");
  await evaluate("[...document.querySelectorAll('.ant-modal button')].find(button=>button.innerText.replace(/\\s/g,'')==='保存语音设置').click()");
  await wait("JSON.parse(localStorage.getItem('caicai.voice-input') || '{}').wakeWord === '小助手'");
  const result = { realLocalRecognition: true, realAudioWorklet: true, syntheticMicrophone: true,
    recordedQuestion: history[0].user_text, turns: history.length, savedWakeWord: '小助手',
    microphoneReleased: released, cameraDenied, composerVisible, model: status.model };
  writeFileSync(join(data, 'voice-chat-smoke.json'), JSON.stringify(result, null, 2));
  console.log('[caicai-voice-check] ' + JSON.stringify(result));
}
