import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

function outputMock() {
  const sources: { buffer: unknown; onended: (() => void) | null;
    connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
  const output = { state: 'suspended', currentTime: 0, destination: {},
    resume: vi.fn(async () => { output.state = 'running'; }),
    decodeAudioData: vi.fn(async () => ({ duration: 5 })),
    createBufferSource: vi.fn(() => {
      const source = { buffer: null as unknown, onended: null as (() => void) | null,
        connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      sources.push(source); return source;
    }),
  };
  const construct = vi.fn();
  vi.stubGlobal('AudioContext', class { constructor() { construct(); return output; } });
  const blob = { arrayBuffer: async () => new ArrayBuffer(8) } as Blob;
  return { output, sources, construct, blob };
}

describe('persistent speech output', () => {
  it('reports the matching transcript only after the source really starts, and clears it on pause/end', async () => {
    const { output, sources } = outputMock();
    const desktop = await import('./desktop');
    const report = vi.spyOn(desktop, 'reportAudioPlayback');
    try {
      const { SpeechPlayback } = await import('./playback');
      const player = new SpeechPlayback(vi.fn());
      player.loadBuffer({ duration: 5 } as AudioBuffer, '第一段文案。');
      expect(report).not.toHaveBeenCalled();
      await player.play();
      expect(report).toHaveBeenLastCalledWith(sources[0], true, 'reply', '第一段文案。');
      output.currentTime = 1; player.pause();
      expect(report).toHaveBeenLastCalledWith(sources[0], false, 'reply');
      await player.play();
      expect(report).toHaveBeenLastCalledWith(sources[1], true, 'reply', '第一段文案。');
      sources[1].onended!();
      expect(report).toHaveBeenLastCalledWith(sources[1], false, 'reply');
      player.loadBuffer({ duration: 5 } as AudioBuffer, '第二段文案。');
      await player.play();
      expect(report).toHaveBeenLastCalledWith(sources[2], true, 'reply', '第二段文案。');
      player.dispose();
      expect(report).toHaveBeenLastCalledWith(sources[2], false, 'reply');
    } finally { report.mockRestore(); }
  });

  it('does not publish a transcript when audio output fails to start', async () => {
    const { output, sources } = outputMock();
    const desktop = await import('./desktop');
    const report = vi.spyOn(desktop, 'reportAudioPlayback');
    try {
      const { SpeechPlayback } = await import('./playback');
      const player = new SpeechPlayback(vi.fn());
      player.loadBuffer({ duration: 5 } as AudioBuffer, '不能提前显示。');
      output.resume.mockRejectedValueOnce(new Error('output failed'));
      await expect(player.play()).rejects.toThrow('output failed');
      expect(sources).toHaveLength(0); expect(report).not.toHaveBeenCalled();
      player.dispose();
    } finally { report.mockRestore(); }
  });

  it('resumes output synchronously during the click and reuses it after generation', async () => {
    const { output, construct, sources, blob } = outputMock();
    const { prepareSpeechPlayback, SpeechPlayback } = await import('./playback');
    const prepared = prepareSpeechPlayback();
    expect(output.resume).toHaveBeenCalledTimes(1);
    await prepared;
    const player = new SpeechPlayback(vi.fn());
    await player.load(blob); await player.play();
    expect(sources[0].start).toHaveBeenCalledWith(0, 0);
    expect(construct).toHaveBeenCalledTimes(1);
    const next = new SpeechPlayback(vi.fn());
    await next.load(blob); await next.play();
    expect(construct).toHaveBeenCalledTimes(1);
    expect(output.resume).toHaveBeenCalledTimes(1);
  });

  it('resumes from the paused position and advances only after a natural ending', async () => {
    const { output, sources, blob } = outputMock();
    const { SpeechPlayback } = await import('./playback');
    const ended = vi.fn(); const player = new SpeechPlayback(ended);
    await player.load(blob); await player.play();
    output.currentTime = 2; player.pause();
    expect(sources[0].stop).toHaveBeenCalledTimes(1);
    expect(sources[0].onended).toBeNull();
    expect(ended).not.toHaveBeenCalled();
    await player.play();
    expect(sources[1].start).toHaveBeenCalledWith(0, 2);
    sources[1].onended!();
    expect(ended).toHaveBeenCalledTimes(1);
    player.dispose();
    await player.play();
    expect(sources).toHaveLength(2);
  });

  it('does not start after a pending resume is cancelled by pause', async () => {
    const { output, sources, blob } = outputMock();
    let resume!: () => void;
    output.resume.mockImplementation(() => new Promise<void>(resolve => {
      resume = () => { output.state = 'running'; resolve(); };
    }));
    const { SpeechPlayback } = await import('./playback');
    const player = new SpeechPlayback(vi.fn());
    await player.load(blob);
    const pending = player.play(); player.pause(); resume(); await pending;
    expect(sources).toHaveLength(0);
  });

  it('keeps decoded audio usable when paused during decoding', async () => {
    const { output, sources, blob } = outputMock();
    let decode!: () => void;
    output.decodeAudioData.mockImplementation(() => new Promise(resolve => {
      decode = () => resolve({ duration: 5 });
    }));
    const { SpeechPlayback } = await import('./playback');
    const player = new SpeechPlayback(vi.fn());
    const loading = player.load(blob);
    await vi.waitFor(() => expect(decode).toBeDefined());
    player.pause(); decode(); await loading; await player.play();
    expect(sources[0].start).toHaveBeenCalledWith(0, 0);
  });
});
