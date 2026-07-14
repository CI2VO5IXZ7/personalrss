// Instagram 抓取 — 旧入口，现仅作为 fetcher 的兼容 re-export。
// 新增代码应直接引用 src/generators/providers/instagram/ 下的实现。

export {
  fetchProfile,
  validateProfile,
  probeProfile
} from '../generators/providers/instagram/fetcher.js';
