export function chatPresentation(state, animations = {}) {
  const phase = state.speaking ? 'speaking' : state.thinking ? 'thinking' : state.waiting ? 'waiting' : 'idle';
  const text = { speaking: '菜菜正在说话', thinking: '菜菜正在想一想…', waiting: '正在准备语音…', idle: '' }[phase];
  const events = animations.events || {};
  const slot = phase === 'speaking' ? events.whisper?.[0]
    : phase === 'thinking' ? events.workStatus?.[0] : undefined;
  const name = Array.isArray(slot) ? slot.find(item => typeof item === 'string' && item) : slot;
  return { phase, text, animation: typeof name === 'string' && name ? name : null };
}

export function validateChatState(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['thinking', 'speaking', 'waiting'].includes(key))
    || Object.values(body).some(value => typeof value !== 'boolean')) throw new Error('无效的聊天状态');
  return { thinking: false, speaking: false, waiting: false, ...body };
}
