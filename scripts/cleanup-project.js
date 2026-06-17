#!/usr/bin/env node

/**
 * Proxi New — Project Cleanup Script
 * 
 * Moves unnecessary files/folders to /home/sahon/Music/Unnecessary/
 * and reorganizes project structure.
 * 
 * Usage:
 *   node scripts/cleanup-project.js           # Full cleanup
 *   node scripts/cleanup-project.js --dry-run # Preview only
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const UNNECESSARY_DIR = '/home/sahon/Music/Unnecessary';

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');

// Files/folders to move to Unnecessary
const MOVE_TARGETS = [
  // Misplaced admin panel
  {
    src: path.join(PROJECT_ROOT, 'test', 'documentation', 'admin'),
    dest: path.join(UNNECESSARY_DIR, 'admin-panel'),
    description: 'Admin panel (misplaced in test/documentation/)',
    size: '~1.2 GB',
  },
  // Redundant start.js
  {
    src: path.join(PROJECT_ROOT, 'start.js'),
    dest: path.join(UNNECESSARY_DIR, 'start.js'),
    description: 'Redundant start.js wrapper',
  },
  // Stale API doc
  {
    src: path.join(PROJECT_ROOT, 'api.md'),
    dest: path.join(UNNECESSARY_DIR, 'api.md'),
    description: 'Stale API design doc',
  },
  // Duplicate identity.json in LangChainAgent
  {
    src: path.join(PROJECT_ROOT, 'src', 'LangChainAgent', 'identity.json'),
    dest: path.join(UNNECESSARY_DIR, 'langchainagent-identity.json'),
    description: 'Duplicate identity.json',
  },
];

// Directories to clean (not move)
const CLEAN_DIRS = [
  // Old .zombiecoder duplicates
  path.join(PROJECT_ROOT, 'scripts', '.zombiecoder'),
  path.join(PROJECT_ROOT, 'test', '.zombiecoder'),
  // Runtime state that shouldn't be in repo
  path.join(PROJECT_ROOT, '.junie'),
  path.join(PROJECT_ROOT, '.opencode'),
  path.join(PROJECT_ROOT, '.vscode'),
];

// Files to consolidate to docs/
const DOC_MOVES = [
  {
    src: path.join(PROJECT_ROOT, 'test', 'documentation', 'agent-proof'),
    dest: path.join(PROJECT_ROOT, 'docs', 'agent-proof'),
    description: 'Agent proof documentation',
  },
];

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`📁 Created: ${dirPath}`);
  }
}

function getDirSize(dirPath) {
  let size = 0;
  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        size += getDirSize(filePath);
      } else {
        size += stat.size;
      }
    }
  } catch (e) {}
  return size;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function moveItem(src, dest, description) {
  if (!fs.existsSync(src)) {
    console.log(`⚠️  Not found: ${src}`);
    return false;
  }

  const stat = fs.statSync(src);
  const size = stat.isDirectory() ? getDirSize(src) : stat.size;

  if (DRY_RUN) {
    console.log(`\n[DRY RUN] Would move:`);
    console.log(`  From: ${src}`);
    console.log(`  To:   ${dest}`);
    console.log(`  Size: ${formatSize(size)}`);
    console.log(`  Reason: ${description}`);
    return true;
  }

  // Ensure destination parent exists
  ensureDir(path.dirname(dest));

  // If destination exists, add timestamp
  if (fs.existsSync(dest)) {
    const timestamp = Date.now();
    const ext = path.extname(dest);
    const base = path.basename(dest, ext);
    const destDir = path.dirname(dest);
    const newDest = path.join(destDir, `${base}-${timestamp}${ext}`);
    fs.renameSync(src, newDest);
    console.log(`✅ Moved (renamed): ${src}`);
    console.log(`   To: ${newDest}`);
    console.log(`   Size: ${formatSize(size)}`);
    return true;
  }

  fs.renameSync(src, dest);
  console.log(`✅ Moved: ${src}`);
  console.log(`   To: ${dest}`);
  console.log(`   Size: ${formatSize(size)}`);
  return true;
}

function cleanDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return;
  }

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would remove: ${dirPath}`);
    return;
  }

  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    console.log(`🗑️  Removed: ${dirPath}`);
  } catch (e) {
    console.log(`⚠️  Could not remove: ${dirPath} (${e.message})`);
  }
}

async function main() {
  console.log('\n🧹 Proxi New — Project Cleanup');
  console.log('═══════════════════════════════════════════════════════════════');
  if (DRY_RUN) console.log('⚠️  DRY RUN MODE — No changes will be made\n');

  // Ensure destination directory exists
  if (!DRY_RUN) {
    ensureDir(UNNECESSARY_DIR);
  }

  let movedCount = 0;
  let cleanedCount = 0;

  // Move unnecessary items
  console.log('\n📦 Moving unnecessary files/folders...\n');
  for (const target of MOVE_TARGETS) {
    if (moveItem(target.src, target.dest, target.description)) {
      movedCount++;
    }
  }

  // Clean duplicate directories
  console.log('\n🗑️  Cleaning duplicate/runtime directories...\n');
  for (const dir of CLEAN_DIRS) {
    if (fs.existsSync(dir)) {
      cleanDir(dir);
      cleanedCount++;
    }
  }

  // Consolidate documentation
  console.log('\n📚 Consolidating documentation...\n');
  for (const doc of DOC_MOVES) {
    if (fs.existsSync(doc.src)) {
      ensureDir(path.dirname(doc.dest));
      if (!DRY_RUN) {
        // Copy, don't move (keep originals for now)
        fs.cpSync(doc.src, doc.dest, { recursive: true });
        console.log(`📄 Copied: ${doc.src} → ${doc.dest}`);
        console.log(`   Reason: ${doc.description}`);
      } else {
        console.log(`[DRY RUN] Would copy: ${doc.src} → ${doc.dest}`);
      }
    }
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`✅ Moved: ${movedCount} items`);
  console.log(`🗑️  Cleaned: ${cleanedCount} directories`);
  
  if (!DRY_RUN) {
    console.log(`\n📦 Files moved to: ${UNNECESSARY_DIR}`);
    console.log('   (You can delete this folder if you don\'t need the old files)');
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
