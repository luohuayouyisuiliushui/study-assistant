import { readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const learnDir = join(__dirname, '..', 'data', 'learn');

function findOrphanedBakFiles(root) {
  const orphans = [];
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(root, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        orphans.push(...findOrphanedBakFiles(full));
      } else if (entry.name.endsWith('.bak')) {
        const jsonPath = full.slice(0, -4);
        if (!existsSync(jsonPath)) {
          orphans.push(full);
        }
      }
    }
  } catch {
    // skip inaccessible directories
  }
  return orphans;
}

export function cleanOrphanedBackups({ dryRun = false } = {}) {
  const orphans = findOrphanedBakFiles(learnDir);

  if (dryRun) {
    return { deleted: orphans, count: orphans.length, dryRun: true };
  }

  for (const f of orphans) {
    try { unlinkSync(f); } catch { /* best effort */ }
  }

  return { count: orphans.length };
}

if (process.argv[1]?.includes('clean-backups')) {
  const dryRun = process.argv.includes('--dry-run');
  const result = cleanOrphanedBackups({ dryRun });
  if (dryRun) {
    if (result.count === 0) {
      console.log('没有孤立的 .bak 文件');
    } else {
      console.log(`[dry-run] 将删除 ${result.count} 个孤立 .bak 文件:`);
      for (const f of result.deleted) console.log('  ' + f);
    }
  } else {
    const size = result.count > 0 ? 'yes' : 'no';
    console.log(`已清理 ${result.count} 个孤立 .bak 文件`);
  }
}
