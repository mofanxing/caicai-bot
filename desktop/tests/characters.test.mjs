import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { readAllConfig, flattenPetList, saveUserConfig, configPathsFor } from '../dist/lib/upstream-tools.mjs';
import { makeSelectionChanges } from '../src/policy.mjs';

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
