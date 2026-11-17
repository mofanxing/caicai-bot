export function loopbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('本地服务地址必须是 http://127.0.0.1:端口 或 http://localhost:端口');
  }
  return url.origin;
}

// 只切换表现层 display，不触及会话、人设、音色及未来任务。保留浏览器显示位。
export function makeSelectionChanges(pets, id) {
  if (typeof id !== 'string' || !pets.some(p => p.id === id)) throw new Error('请选择已安装的角色');
  const desktopOn = display => display === 'both' || display === 'desktop';
  const target = pets.find(p => p.id === id);
  const changes = [];
  if (!desktopOn(target.display)) changes.push({ id, display: target.display === 'web' ? 'both' : 'desktop' });
  for (const pet of pets) if (pet.id !== id && desktopOn(pet.display)) changes.push({ id: pet.id, display: pet.display === 'both' ? 'web' : 'none' });
  return changes;
}
