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

test('同为说话阶段时，气泡逐段显示对应文字，停止后清掉旧正文', () => {
  const first = validateChatState({ speaking: true, text: '第一段，先说原因。' });
  const second = validateChatState({ speaking: true, text: '第二段，再说做法。' });
  assert.equal(chatPresentation(first).text, first.text);
  assert.equal(chatPresentation(second).text, second.text);
  assert.notEqual(chatPresentation(first).text, chatPresentation(second).text);
  assert.equal(chatPresentation(validateChatState({ speaking: false, text: first.text })).text, '');
  for (const value of [null, 12, {}, '好'.repeat(601)]) {
    assert.throws(() => validateChatState({ speaking: true, text: value }));
  }
  assert.equal(chatPresentation(validateChatState({ speaking: true, text: '<script>文字</script>' })).text,
    '<script>文字</script>'); // Data stays text; the native bubble renderer handles escaping.
});
