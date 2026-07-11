import { rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cacheDir = join(__dirname, '..', 'cache');

if (!existsSync(cacheDir)) {
  console.log('缓存目录不存在，无需清理');
  process.exit(0);
}

let removedCount = 0;
for (const entry of ['prefix-cache.json']) {
  const p = join(cacheDir, entry);
  if (existsSync(p)) {
    rmSync(p, { force: true });
    removedCount++;
    console.log(`  已删除: ${entry}`);
  }
}

console.log(`缓存清理完成，共清理 ${removedCount} 个文件`);
