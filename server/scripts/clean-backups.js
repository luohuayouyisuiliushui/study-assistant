import { readdirSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const learnDir = join(__dirname, '..', 'data', 'learn');
const backupV2Dir = join(learnDir, '.backups-v2');
const plansDir = join(learnDir, 'plans');

/**
 * Find orphaned .bak files (where the corresponding .json file no longer exists).
 */
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

/**
 * Find orphaned .backups-v2/ files (where the corresponding plan file no longer exists).
 */
function findOrphanedV2Backups() {
  const orphans = [];
  try {
    if (!existsSync(backupV2Dir)) return orphans;

    const entries = readdirSync(backupV2Dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json')) continue;

      const planId = entry.name.replace('.json', '');
      const planFile = join(plansDir, planId + '.json');

      // Check if the original plan file exists
      if (!existsSync(planFile)) {
        orphans.push(join(backupV2Dir, entry.name));
      }
    }
  } catch {
    // skip inaccessible directories
  }
  return orphans;
}

/**
 * Clean all orphaned backup files (.bak and .backups-v2/).
 */
export function cleanOrphanedBackups({ dryRun = false } = {}) {
  // Find orphaned .bak files
  const orphanedBak = findOrphanedBakFiles(learnDir);

  // Find orphaned .backups-v2/ files
  const orphanedV2 = findOrphanedV2Backups();

  const allOrphans = [...orphanedBak, ...orphanedV2];

  if (dryRun) {
    return {
      deleted: allOrphans,
      count: allOrphans.length,
      bakCount: orphanedBak.length,
      v2Count: orphanedV2.length,
      dryRun: true
    };
  }

  for (const f of allOrphans) {
    try { unlinkSync(f); } catch { /* best effort */ }
  }

  return {
    count: allOrphans.length,
    bakCount: orphanedBak.length,
    v2Count: orphanedV2.length
  };
}

if (process.argv[1]?.includes('clean-backups')) {
  const dryRun = process.argv.includes('--dry-run');
  const result = cleanOrphanedBackups({ dryRun });
  if (dryRun) {
    if (result.count === 0) {
      console.log('没有孤立的备份文件');
    } else {
      console.log(`[dry-run] 将删除 ${result.count} 个孤立备份文件:`);
      if (result.bakCount > 0) console.log(`  - .bak 文件: ${result.bakCount} 个`);
      if (result.v2Count > 0) console.log(`  - .backups-v2/ 文件: ${result.v2Count} 个`);
      for (const f of result.deleted) console.log('  ' + f);
    }
  } else {
    console.log(`已清理 ${result.count} 个孤立备份文件 (.bak: ${result.bakCount}, .backups-v2/: ${result.v2Count})`);
  }
}
