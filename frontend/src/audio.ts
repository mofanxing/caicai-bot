export function encodeWav(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const label = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
  };
  label(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); label(8, 'WAVE');
  label(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((value, index) => {
    const sample = Math.max(-1, Math.min(1, value));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  });
  return buffer;
}

export async function prepareReference(file: File): Promise<Blob> {
  if (file.size > 20 * 1024 * 1024) throw new Error('参考录音不能超过 20 MB。');
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error('浏览器无法读取这段录音，请尝试 WAV 或 MP3 文件。');
  } finally { await context.close(); }
  if (decoded.duration < 3 || decoded.duration > 30) throw new Error('请选择 3～30 秒的清晰参考录音。');
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const source = offline.createBufferSource();
  source.buffer = decoded; source.connect(offline.destination); source.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);
  if (!samples.some(value => Math.abs(value) > 0.0001)) throw new Error('录音似乎是静音，请换一段有人声的录音。');
  return new Blob([encodeWav(samples)], { type: 'audio/wav' });
}
