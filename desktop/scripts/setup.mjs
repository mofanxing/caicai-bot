import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { desktopRoot, upstreamRoot } from './paths.mjs';

const lock = JSON.parse(readFileSync(join(desktopRoot, 'upstream.lock.json'), 'utf8'));
if (!/^[a-f0-9]{40}$/.test(lock.commit)) throw new Error('上游提交必须是完整 SHA');
const git = (...args) => execFileSync('git', args, { cwd: upstreamRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
mkdirSync(upstreamRoot, { recursive: true });
if (!existsSync(join(upstreamRoot, '.git'))) {
  git('init', '--quiet');
  git('remote', 'add', 'origin', lock.repository);
}
if (git('remote', 'get-url', 'origin') !== lock.repository) throw new Error('上游地址与锁文件不一致');
if (git('status', '--porcelain')) throw new Error('上游缓存有本地改动，先保留改动再重试');
try {
  if (git('rev-parse', '--verify', 'HEAD') === lock.commit) {
    console.log(`dsh-pet ${lock.version} 已固定：${lock.commit}`);
    process.exit(0);
  }
} catch { /* 首次初始化，没有 HEAD。 */ }
git('fetch', '--depth', '1', 'origin', lock.commit);
git('checkout', '--detach', lock.commit);
if (git('rev-parse', 'HEAD') !== lock.commit) throw new Error('上游提交校验失败');
console.log(`dsh-pet ${lock.version} 已固定：${lock.commit}`);
