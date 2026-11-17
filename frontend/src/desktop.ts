// The bundled desktop page uses the same UI and audio pipeline as the web workbench.
export const isDesktop = location.pathname.startsWith('/chat/');
export const chatChannel = isDesktop ? 'desktop' : 'debug';
const params = new URLSearchParams(location.hash.slice(1));
const capability = isDesktop ? params.get('token') || '' : '';
if (isDesktop && params.has('token')) history.replaceState(null, '', location.pathname);

export function desktopHeaders(): Record<string, string> {
  return capability ? { 'X-DSH-Pet-Token': capability } : {};
}

let current = { thinking: false, speaking: false, waiting: false };
let reporting: Promise<unknown> = Promise.resolve();
const audioSources = new Set<object>();
const waitingPlayers = new Set<string>();
export function reportAudioPlayback(source: object, active: boolean) {
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
  const body = JSON.stringify(current);
  reporting = reporting.catch(() => {}).then(() => fetch('/caicai/chat-state', { method: 'POST', headers: {
    ...desktopHeaders(), 'Content-Type': 'application/json',
  }, body, signal: AbortSignal.timeout(4000) })).catch(() => {});
}
