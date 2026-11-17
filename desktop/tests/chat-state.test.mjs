import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatPresentation, validateChatState } from '../src/chat-state.mjs';

test('真实出声优先于生成状态，停止出声不会清掉仍在进行的文字生成', () => {
  const animations = { events: { workStatus: [['think']], whisper: ['talk'] } };
  assert.equal(chatPresentation({ speaking: true, thinking: true }, animations).animation, 'talk');
  assert.equal(chatPresentation({ speaking: false, thinking: true }, animations).animation, 'think');
  assert.equal(chatPresentation({ thinking: false, waiting: true }, animations).phase, 'waiting');
  assert.equal(chatPresentation({}, animations).phase, 'idle');
});

test('缺少状态素材时保留气泡并回退原生动画，不硬编码角色动作名', () => {
  assert.deepEqual(chatPresentation({ speaking: true }), { phase: 'speaking', text: '菜菜正在说话', animation: null });
  for (const value of [null, [], { thinking: 'yes' }, { animation: 'unknown' }]) assert.throws(() => validateChatState(value));
  assert.deepEqual(validateChatState({ thinking: true }), { thinking: true, speaking: false, waiting: false });
});
