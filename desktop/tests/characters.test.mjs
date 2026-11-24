import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { readAllConfig, flattenPetList, saveUserConfig, configPathsFor } from '../dist/lib/upstream-tools.mjs';
import { makeSelectionChanges } from '../src/policy.mjs';
import { execFileSync } from 'node:child_process';

test('固定上游原生角色包可被发现，切换后重新读取仍保留所选形象及自定义配置', () => {
  const home = mkdtempSync(join(tmpdir(), 'caicai-pet-test-'));
  try {
    const paths = configPathsFor(resolve(import.meta.dirname, '../dist'), home);
    mkdirSync(paths.petDir, { recursive: true });
    const main = readAllConfig(paths).main;
    const primary = { ...main.pets[0], display: 'desktop' };
    const second = { ...primary, id: 'fixture', name: '仅用于配置测试的角色', display: 'none' };
    writeFileSync(paths.userFile, JSON.stringify({ pets: [primary], customField: { keep: true } }));
    const packFile = join(paths.petDir, 'fixture-config.json');
    writeFileSync(packFile, JSON.stringify({ pets: [second], whisperPrompt: 'preserve persona', customField: { keep: true } }));
    let merged = readAllConfig(paths);
    assert.deepEqual(Object.keys(merged), ['main', 'fixture']);
    const changes = makeSelectionChanges(flattenPetList(merged), second.id);
    for (const change of changes) {
      const entry = Object.keys(merged).find(entry => merged[entry].pets.some(pet => pet.id === change.id));
      const source = entry === 'main' ? paths.userFile : packFile;
      const existing = JSON.parse(readFileSync(source, 'utf8'));
      const saved = saveUserConfig({ pets: merged[entry].pets.map(p => p.id === change.id ? { ...p, display: change.display } : p) }, existing);
      assert.ok(saved); writeFileSync(source, JSON.stringify(saved));
      merged = readAllConfig(paths);
    }
    // 模拟退出再启动：不复用前一次的合并对象。
    const afterRestart = readAllConfig(configPathsFor(resolve(import.meta.dirname, '../dist'), home));
    assert.equal(afterRestart.main.pets[0].display, 'none');
    assert.equal(afterRestart.fixture.pets[0].display, 'desktop');
    assert.equal(afterRestart.fixture.whisperPrompt, 'preserve persona');
    assert.deepEqual(JSON.parse(readFileSync(packFile, 'utf8')).customField, { keep: true });
    assert.deepEqual(JSON.parse(readFileSync(paths.userFile, 'utf8')).customField, { keep: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('蔡蔡实装包完整覆盖原生动作，安装和再次安装保留已有配置', () => {
  const home = mkdtempSync(join(tmpdir(), 'caicai-pack-test-'));
  const root = resolve(import.meta.dirname, '..');
  const source = JSON.parse(readFileSync(join(root, 'characters/caicai/caicai-config.json'), 'utf8'));
  const paths = configPathsFor(join(root, 'dist'), home);
  const install = () => execFileSync(process.execPath, [join(root, 'scripts/install-caicai.mjs')], {
    env: { ...process.env, DSH_HOME: home }, encoding: 'utf8',
  });
  try {
    mkdirSync(paths.petDir, { recursive: true });
    writeFileSync(paths.userFile, JSON.stringify({ pets: [{ id: 'main', name: '原来的形象', display: 'desktop' }] }));
    const before = readFileSync(paths.userFile, 'utf8');
    install();
    const merged = readAllConfig(paths);
    assert.deepEqual(merged.caicai.animations, source.animations, '非法配置不能悄悄回退到大肥鱼动作');
    assert.equal(merged.caicai.pets[0].name, '蔡蔡');
    assert.equal(merged.caicai.pets[0].display, 'none');
    assert.deepEqual(merged.caicai.memes, {});
    assert.equal(readFileSync(paths.userFile, 'utf8'), before);
    const a = merged.caicai.animations;
    const names = new Set([
      ...a.idle, ...a.turn, ...a.drag, ...a.clicks, ...a.moves.actions.map(x => x.name),
      ...a.categories.flatMap(x => x.actions), ...Object.values(a.events).flat(2),
      ...a.sleep.flatMap(x => [...x.start, ...x.loop, ...x.end]),
    ]);
    assert.ok(names.size > 0, '至少登记一个动作；扩展动作不应受固定数量限制');
    for (const name of names) {
      const bytes = readFileSync(join(paths.petDir, 'caicai-animation', name + '.webm'));
      assert.deepEqual([...bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3], name);
      assert.ok(bytes.length > 10000, name);
    }
    const custom = { ...source, pets: [{ ...source.pets[0], display: 'desktop' }], customField: '保留我的配置' };
    const target = join(paths.petDir, 'caicai-config.json');
    writeFileSync(target, JSON.stringify(custom));
    install();
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), custom);
    assert.equal(readAllConfig(paths).caicai.pets[0].display, 'desktop');
    assert.equal(readFileSync(paths.userFile, 'utf8'), before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
