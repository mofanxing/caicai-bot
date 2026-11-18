import { useEffect, useRef } from 'react';
import type { Api } from './api';
import type { SpeechJob } from './types';
import { SpeechPlayback } from './playback';
import { subscribeDesktopState } from './desktop';

const STORAGE = 'caicai.task-notifications.played';
const SOURCE = 'caicai-task-notification';

// Task audio has no chat message, toast, playlist or replay controls.
export function TaskNotifications({ api, autoRead, busy }: {
  api: Api; autoRead: boolean; busy: boolean;
}) {
  const enabled = useRef(false); enabled.current = autoRead && !busy;
  const pause = useRef<() => void>();
  useEffect(() => { if (!enabled.current) pause.current?.(); }, [autoRead, busy]);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let current: SpeechJob | undefined;
    let player: SpeechPlayback | undefined;
    let playing = false;
    let otherSpeaking = false;
    let cleaning = false;
    const played = new Set<string>();
    const pendingDelete = new Set<string>();
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE) || '{}');
      if (Array.isArray(saved.played)) saved.played.forEach((id: string) => played.add(id));
      if (Array.isArray(saved.pending)) saved.pending.forEach((id: string) => pendingDelete.add(id));
    } catch { /* An invalid cache does not affect the durable server queue. */ }
    const save = () => {
      try { localStorage.setItem(STORAGE, JSON.stringify({ played: [...played].slice(-1000), pending: [...pendingDelete] })); }
      catch { /* Still attempt server cleanup if browser storage is unavailable. */ }
    };
    async function cleanupPlayed() {
      if (cleaning) return;
      cleaning = true;
      try {
        for (const id of pendingDelete) {
          if (abort.signal.aborted) break;
          try { await api.consumeTaskNotification(id); pendingDelete.delete(id); save(); }
          catch { /* Retry deletion without replaying the already-finished audio. */ }
        }
      } finally { cleaning = false; }
    }
    const stop = () => { playing = false; player?.pause(); };
    pause.current = stop;
    const unsubscribe = subscribeDesktopState(state => { otherSpeaking = state.speaking; });
    const onOtherPlayback = (event: Event) => {
      if ((event as CustomEvent).detail !== SOURCE) stop();
    };
    window.addEventListener('caicai-audio-start', onOtherPlayback);
    async function poll() {
      try {
        await cleanupPlayed();
        if (abort.signal.aborted || playing || !enabled.current || otherSpeaking) return;
        const jobs = await api.taskNotifications();
        if (abort.signal.aborted) return;
        // Progress can expire or become obsolete when the task finishes while paused.
        if (current && !jobs.some(job => job.id === current?.id)) {
          player?.dispose(); player = undefined; current = undefined;
        }
        if (!current) current = jobs.find(job => !played.has(job.id));
        if (!current) return;
        const job = await api.speechJob(current.id, abort.signal);
        if (abort.signal.aborted) return;
        if (job.status === 'failed') {
          pendingDelete.add(job.id); played.add(job.id); save(); current = undefined;
          await cleanupPlayed(); return;
        }
        if (job.status !== 'completed') return;
        if (!player) {
          const id = job.id;
          player = new SpeechPlayback(() => {
            // Only a natural audio ending consumes this one-shot notification.
            playing = false; played.add(id); pendingDelete.add(id); save();
            player?.dispose(); player = undefined; current = undefined;
            void cleanupPlayed();
          });
          await player.load(await api.speechAudio(id, abort.signal), job.text);
        }
        if (abort.signal.aborted || !enabled.current || otherSpeaking) return;
        window.dispatchEvent(new CustomEvent('caicai-audio-start', { detail: SOURCE }));
        playing = true;
        try { await player.play(); }
        catch { playing = false; }
      } catch (error) {
        playing = false; player?.dispose(); player = undefined;
        if (error && typeof error === 'object' && 'status' in error && error.status === 404) current = undefined;
      }
      finally { if (!abort.signal.aborted) timer = setTimeout(poll, 1000); }
    }
    void poll();
    return () => {
      abort.abort(); clearTimeout(timer); unsubscribe();
      window.removeEventListener('caicai-audio-start', onOtherPlayback);
      player?.dispose(); if (pause.current === stop) pause.current = undefined;
    };
  }, [api]);
  return null;
}
