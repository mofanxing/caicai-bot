import { describe, expect, it } from 'vitest';
import { encodeWav } from './audio';

describe('reference audio encoding', () => {
  it('writes a mono PCM16 WAV with correct sample rate, length and clipped samples', () => {
    const result = encodeWav(new Float32Array([-2, -0.5, 0, 0.5, 2]), 16000);
    const view = new DataView(result);
    const label = (start: number, size: number) => String.fromCharCode(...new Uint8Array(result, start, size));
    expect(label(0, 4)).toBe('RIFF'); expect(label(8, 4)).toBe('WAVE');
    expect(label(36, 4)).toBe('data'); expect(view.getUint32(4, true)).toBe(46);
    expect(view.getUint16(20, true)).toBe(1); expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000); expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10);
    expect([0, 1, 2, 3, 4].map(index => view.getInt16(44 + index * 2, true)))
      .toEqual([-32768, -16384, 0, 16383, 32767]);
  });
});
