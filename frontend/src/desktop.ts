// The bundled desktop page uses the same UI and audio pipeline as the web workbench.
export const isDesktop = location.pathname.startsWith('/chat/');
export const chatChannel = isDesktop ? 'desktop' : 'debug';
const params = new URLSearchParams(location.hash.slice(1));
const capability = isDesktop ? params.get('token') || '' : '';
if (isDesktop && params.has('token')) history.replaceState(null, '', location.pathname);

export function desktopHeaders(): Record<string, string> {
  return capability ? { 'X-DSH-Pet-Token': capability } : {};
}

export type DesktopState = { thinking: boolean; speaking: boolean; waiting: boolean };
let current: DesktopState = { thinking: false, speaking: false, waiting: false };
let reporting: Promise<unknown> = Promise.resolve();
const audioSources = new Set<object>();
const feedbackSources = new Set<object>();
const spokenTexts = new Map<object, string>();
const listeners = new Set<(state: DesktopState) => void>();
const waitingPlayers = new Set<string>();
export function subscribeDesktopState(listener: (state: DesktopState) => void) {
  listeners.add(listener); listener({ ...current });
  return () => { listeners.delete(listener); };
}
export function reportAudioPlayback(source: object, active: boolean, kind: 'reply' | 'feedback' = 'reply', text = '') {
  if (active && text.trim()) spokenTexts.set(source, text);
  else spokenTexts.delete(source);
  if (kind === 'feedback') {
    if (active) feedbackSources.add(source); else feedbackSources.delete(source);
    sendSnapshot(); return;
  }
  if (active) audioSources.add(source); else audioSources.delete(source);
  reportDesktopState({ speaking: audioSources.size > 0 });
}
export function reportSpeechWaiting(id: string, active: boolean) {
  if (active) waitingPlayers.add(id); else waitingPlayers.delete(id);
  reportDesktopState({ waiting: waitingPlayers.size > 0 });
}
export function reportDesktopState(state: { thinking?: boolean; speaking?: boolean; waiting?: boolean }) {
  if (!isDesktop) return;
  current = { ...current, ...state };
  for (const listener of listeners) listener({ ...current });
  sendSnapshot();
}
function sendSnapshot() {
  if (!isDesktop) return;
  const speaking = current.speaking || feedbackSources.size > 0;
  const sources = audioSources.size ? audioSources : feedbackSources;
  const text = speaking ? [...sources].map(source => spokenTexts.get(source) || '').at(-1) : '';
  const body = JSON.stringify({ ...current, speaking, ...(text ? { text } : {}) });
  reporting = reporting.catch(() => {}).then(() => fetch('/caicai/chat-state', { method: 'POST', headers: {
    ...desktopHeaders(), 'Content-Type': 'application/json',
  }, body, signal: AbortSignal.timeout(4000) })).catch(() => {});
}
