// 导出固定上游的真实配置读写函数，供兼容性测试和角色检查使用。
export { readAllConfig, flattenPetList, saveUserConfig } from 'upstream/src/host/config.ts';
export { readJsonc } from 'upstream/src/host/config/jsonc.ts';
export { configPathsFor } from 'upstream/src/standalone/options.ts';
