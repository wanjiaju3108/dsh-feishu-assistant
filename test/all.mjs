/**
 * 跑全部回归：顺序起每个 `*-check.mjs` 子进程，任一失败整体失败。
 *
 * 每个用例是独立进程（它们各自 `process.exit`），所以这里用 spawn 而不是 import。
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = new URL('.', import.meta.url);
const checks = readdirSync(dir).filter((name) => name.endsWith('-check.mjs')).sort();

const failed = [];
for (const name of checks) {
  console.log(`\n=== ${name} ===`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(name, dir))], { stdio: 'inherit' });
  if (result.status !== 0) failed.push(name);
}

console.log(`\n${checks.length - failed.length}/${checks.length} 个用例通过`);
if (failed.length > 0) {
  console.log(`失败：${failed.join('、')}`);
  process.exit(1);
}
