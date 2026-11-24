import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { desktopRoot } from './paths.mjs';

// Explicit installation only. Never replaces an existing character configuration.
const source = join(desktopRoot, 'characters/caicai');
const data = resolve(process.env.CAICAI_DESKTOP_DATA || join(desktopRoot, '.data'));
const dshHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(data, 'dsh');
const destination = join(dshHome, 'dsh-pet/pet');
const config = JSON.parse(readFileSync(join(source, 'caicai-config.json'), 'utf8'));
const names = new Set();
const collect = value => {
  if (typeof value === 'string') names.add(value);
  else if (Array.isArray(value)) value.forEach(collect);
};
const animations = config.animations;
for (const key of ['idle', 'turn', 'drag', 'clicks']) collect(animations[key]);
for (const action of animations.moves.actions) collect(action.name);
for (const category of animations.categories) collect(category.actions);
Object.values(animations.events).forEach(collect);
for (const set of animations.sleep || []) Object.values(set).forEach(collect);
for (const name of names) {
  if (name.includes('/') || name.includes('\\') || !existsSync(join(source, 'caicai-animation', name + '.webm'))) {
    throw new Error('蔡蔡角色素材缺失或名称非法：' + name);
  }
}
mkdirSync(join(destination, 'caicai-animation'), { recursive: true });
let installed = 0;
function copyNew(from, to) {
  try { copyFileSync(from, to, constants.COPYFILE_EXCL); installed++; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
for (const name of names) {
  copyNew(join(source, 'caicai-animation', name + '.webm'), join(destination, 'caicai-animation', name + '.webm'));
}
copyNew(join(source, 'caicai-character.png'), join(destination, 'caicai-character.png'));
copyNew(join(source, 'README.md'), join(destination, 'caicai-README.md'));
// Publish the config last so discovery cannot observe half-installed media.
copyNew(join(source, 'caicai-config.json'), join(destination, 'caicai-config.json'));
console.log(`蔡蔡已安装：${destination}（新增 ${installed} 个文件；已有文件与显示选择保留）`);
console.log('打开或刷新桌宠控制面板，选择“蔡蔡 · caicai”并点击“切换形象”。');
