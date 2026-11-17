import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const upstreamRoot = resolve(desktopRoot, '.cache/upstream');
export const packageRoot = resolve(upstreamRoot, 'dsh-pet');
export const distRoot = resolve(desktopRoot, 'dist');
