#!/usr/bin/env node

/**
 * Proxi New — Environment Setup & Dependency Manager
 * 
 * This script:
 * 1. Checks computer environment (Node.js, npm, ports)
 * 2. Validates project dependencies
 * 3. Installs missing dependencies
 * 4. Cleans old caches and logs
 * 5. Stops conflicting ports
 * 6. Logs results to logs/setup-*.json
 * 
 * Usage:
 *   node scripts/setup-environment.js           # Full setup
 *   node scripts/setup-environment.js --dry-run # Preview only
 *   node scripts/setup-environment.js --clean   # Clean only
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const net = require('net');

// ─── Configuration ──────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');
const PACKAGE_JSON = path.join(PROJECT_ROOT, 'package.json');
const Admin_PACKAGE_JSON = path.join(PROJECT_ROOT, 'test', 'documentation', 'admin', 'package.json');

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const CLEAN_ONLY = ARGS.includes('--clean');

// Required system dependencies
const REQUIRED = {
  node: { minVersion: '18.0.0', command: 'node --version' },
  npm: { minVersion: '10.0.0', command: 'npm --version' },
};

// Ports to check (from transport/services.json)
const PORTS = {
  'proxi-api': 9999,
  'admin-panel': 3001,
  'mcp-server': 9999,
  'qdrant': 6333,
};

// ─── Logging ────────────────────────────────────────────────────

const logEntries = [];
const startTime = Date.now();

function log(level, message, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...details,
  };
  logEntries.push(entry);
  
  const icon = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'success' ? '✅' : 'ℹ️';
  console.log(`${icon} ${message}`);
}

function saveLog(status) {
  const duration = Date.now() - startTime;
  const logFile = {
    timestamp: new Date().toISOString(),
    status, // 'success' | 'partial' | 'failed'
    duration_ms: duration,
    dry_run: DRY_RUN,
    summary: {
      total: logEntries.length,
      errors: logEntries.filter(e => e.level === 'error').length,
      warnings: logEntries.filter(e => e.level === 'warn').length,
      successes: logEntries.filter(e => e.level === 'success').length,
    },
    entries: logEntries,
  };

  // Ensure logs directory exists
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }

  const logFileName = `setup-${new Date().toISOString().split('T')[0]}-${Date.now()}.json`;
  const logPath = path.join(LOGS_DIR, logFileName);
  
  fs.writeFileSync(logPath, JSON.stringify(logFile, null, 2));
  console.log(`\n📝 Log saved: ${logPath}`);
  
  return logPath;
}

// ─── Utility Functions ──────────────────────────────────────────

function runCommand(cmd, options = {}) {
  try {
    const result = execSync(cmd, { 
      encoding: 'utf-8', 
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options 
    });
    return { success: true, output: result.trim() };
  } catch (error) {
    return { success: false, error: error.message, output: error.stdout || '' };
  }
}

function getVersion(versionStr) {
  // Extract version number from string like "v18.17.0" or "10.5.0"
  const match = versionStr.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: parseInt(match[1]), minor: parseInt(match[2]), patch: parseInt(match[3]) };
}

function compareVersions(current, required) {
  if (!current || !required) return false;
  if (current.major > required.major) return true;
  if (current.major < required.major) return false;
  if (current.minor > required.minor) return true;
  if (current.minor < required.minor) return false;
  return current.patch >= required.patch;
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

function killProcessOnPort(port) {
  return new Promise((resolve) => {
    try {
      // Find process using the port
      const result = runCommand(`lsof -ti:${port}`);
      if (result.success && result.output) {
        const pids = result.output.split('\n').filter(Boolean);
        for (const pid of pids) {
          runCommand(`kill -9 ${pid}`);
          log('success', `Killed process ${pid} on port ${port}`);
        }
        resolve(true);
      } else {
        resolve(false);
      }
    } catch (e) {
      resolve(false);
    }
  });
}

// ─── Step 1: Check System Environment ───────────────────────────

async function checkSystemEnvironment() {
  log('info', '═══════════════════════════════════════════════════════════');
  log('info', ' STEP 1: Checking System Environment');
  log('info', '═══════════════════════════════════════════════════════════');

  const issues = [];

  // Check Node.js
  const nodeResult = runCommand(REQUIRED.node.command);
  if (nodeResult.success) {
    const nodeVersion = getVersion(nodeResult.output);
    const requiredVersion = getVersion(REQUIRED.node.minVersion);
    if (compareVersions(nodeVersion, requiredVersion)) {
      log('success', `Node.js ${nodeResult.output} ✓`);
    } else {
      log('error', `Node.js ${nodeResult.output} is below minimum ${REQUIRED.node.minVersion}`);
      issues.push('node_version');
    }
  } else {
    log('error', 'Node.js not found');
    issues.push('node_missing');
  }

  // Check npm
  const npmResult = runCommand(REQUIRED.npm.command);
  if (npmResult.success) {
    const npmVersion = getVersion(npmResult.output);
    const requiredVersion = getVersion(REQUIRED.npm.minVersion);
    if (compareVersions(npmVersion, requiredVersion)) {
      log('success', `npm ${npmResult.output} ✓`);
    } else {
      log('error', `npm ${npmResult.output} is below minimum ${REQUIRED.npm.minVersion}`);
      issues.push('npm_version');
    }
  } else {
    log('error', 'npm not found');
    issues.push('npm_missing');
  }

  // Check disk space
  const diskResult = runCommand("df -h / | tail -1 | awk '{print $4}'");
  if (diskResult.success) {
    log('info', `Available disk space: ${diskResult.output}`);
  }

  return issues;
}

// ─── Step 2: Check & Clean Ports ────────────────────────────────

async function checkAndCleanPorts() {
  log('info', '\n═══════════════════════════════════════════════════════════');
  log('info', ' STEP 2: Checking Ports');
  log('info', '═══════════════════════════════════════════════════════════');

  const issues = [];

  for (const [name, port] of Object.entries(PORTS)) {
    const inUse = await isPortInUse(port);
    if (inUse) {
      log('warn', `Port ${port} (${name}) is in use`);
      if (!DRY_RUN) {
        const killed = await killProcessOnPort(port);
        if (killed) {
          log('success', `Freed port ${port} (${name})`);
        } else {
          log('error', `Could not free port ${port} (${name})`);
          issues.push(`port_${name}`);
        }
      } else {
        log('info', `[DRY RUN] Would kill process on port ${port}`);
      }
    } else {
      log('success', `Port ${port} (${name}) available ✓`);
    }
  }

  return issues;
}

// ─── Step 3: Clean Old Caches ───────────────────────────────────

async function cleanCaches() {
  log('info', '\n═══════════════════════════════════════════════════════════');
  log('info', ' STEP 3: Cleaning Old Caches');
  log('info', '═══════════════════════════════════════════════════════════');

  const cleanTargets = [
    // Old logs (older than 7 days)
    { path: LOGS_DIR, pattern: /setup-.*\.json$/, maxAge: 7 * 24 * 60 * 60 * 1000 },
    // TypeScript build cache
    { path: PROJECT_ROOT, pattern: /\.tsbuildinfo$/ },
    // Next.js build cache (if admin panel exists)
    { path: path.join(PROJECT_ROOT, 'test', 'documentation', 'admin', '.next'), isDir: true },
    // NPM cache
    { path: path.join(PROJECT_ROOT, 'node_modules', '.cache'), isDir: true },
  ];

  for (const target of cleanTargets) {
    try {
      if (!fs.existsSync(target.path)) continue;

      const stat = fs.statSync(target.path);
      
      if (target.isDir) {
        // Remove directory
        const size = getDirSize(target.path);
        if (!DRY_RUN) {
          fs.rmSync(target.path, { recursive: true, force: true });
          log('success', `Cleaned directory: ${path.relative(PROJECT_ROOT, target.path)} (${formatSize(size)})`);
        } else {
          log('info', `[DRY RUN] Would clean: ${path.relative(PROJECT_ROOT, target.path)} (${formatSize(size)})`);
        }
      } else if (target.pattern && target.maxAge) {
        // Clean old files matching pattern
        const files = fs.readdirSync(target.path);
        let cleaned = 0;
        for (const file of files) {
          if (target.pattern.test(file)) {
            const filePath = path.join(target.path, file);
            const fileStat = fs.statSync(filePath);
            if (Date.now() - fileStat.mtimeMs > target.maxAge) {
              if (!DRY_RUN) {
                fs.unlinkSync(filePath);
                cleaned++;
              } else {
                cleaned++;
              }
            }
          }
        }
        if (cleaned > 0) {
          log('success', `Cleaned ${cleaned} old files from ${path.relative(PROJECT_ROOT, target.path)}`);
        }
      }
    } catch (e) {
      log('warn', `Could not clean ${target.path}: ${e.message}`);
    }
  }

  return [];
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

// ─── Step 4: Check & Install Dependencies ───────────────────────

async function checkDependencies() {
  log('info', '\n═══════════════════════════════════════════════════════════');
  log('info', ' STEP 4: Checking Dependencies');
  log('info', '═══════════════════════════════════════════════════════════');

  const issues = [];

  // Check root package.json
  if (!fs.existsSync(PACKAGE_JSON)) {
    log('error', 'package.json not found');
    issues.push('package_json_missing');
    return issues;
  }

  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf-8'));
  const nodeModulesPath = path.join(PROJECT_ROOT, 'node_modules');

  // Check if node_modules exists
  if (!fs.existsSync(nodeModulesPath)) {
    log('warn', 'node_modules not found');
    if (!DRY_RUN) {
      log('info', 'Installing dependencies...');
      const result = runCommand('npm install', { cwd: PROJECT_ROOT });
      if (result.success) {
        log('success', 'Dependencies installed successfully');
      } else {
        log('error', 'Failed to install dependencies');
        issues.push('npm_install_failed');
      }
    } else {
      log('info', '[DRY RUN] Would run: npm install');
    }
  } else {
    // Check for outdated dependencies
    log('info', 'Checking for outdated dependencies...');
    const outdatedResult = runCommand('npm outdated --json', { cwd: PROJECT_ROOT });
    if (outdatedResult.success && outdatedResult.output) {
      try {
        const outdated = JSON.parse(outdatedResult.output);
        const count = Object.keys(outdated).length;
        if (count > 0) {
          log('warn', `${count} outdated dependencies found`);
          if (!DRY_RUN) {
            log('info', 'Updating dependencies...');
            const updateResult = runCommand('npm update', { cwd: PROJECT_ROOT });
            if (updateResult.success) {
              log('success', 'Dependencies updated');
            } else {
              log('warn', 'Some dependencies could not be updated');
            }
          } else {
            log('info', '[DRY RUN] Would run: npm update');
          }
        } else {
          log('success', 'All dependencies up to date ✓');
        }
      } catch (e) {
        log('info', 'Could not parse outdated dependencies');
      }
    }

    // Check for missing critical dependencies
    const criticalDeps = [
      'express', 'groq-sdk', 'better-sqlite3', 'cors', 'dotenv',
      '@langchain/langgraph', '@langchain/openai', '@langchain/core'
    ];

    const missing = criticalDeps.filter(dep => !fs.existsSync(path.join(nodeModulesPath, dep)));
    if (missing.length > 0) {
      log('warn', `Missing critical dependencies: ${missing.join(', ')}`);
      if (!DRY_RUN) {
        const installResult = runCommand(`npm install ${missing.join(' ')}`, { cwd: PROJECT_ROOT });
        if (installResult.success) {
          log('success', `Installed missing dependencies: ${missing.join(', ')}`);
        } else {
          log('error', `Failed to install: ${missing.join(', ')}`);
          issues.push('critical_deps_missing');
        }
      } else {
        log('info', `[DRY RUN] Would install: ${missing.join(', ')}`);
      }
    } else {
      log('success', 'All critical dependencies present ✓');
    }
  }

  // Check admin panel dependencies (if exists)
  if (fs.existsSync(Admin_PACKAGE_JSON)) {
    const adminNodeModules = path.join(PROJECT_ROOT, 'test', 'documentation', 'admin', 'node_modules');
    if (!fs.existsSync(adminNodeModules)) {
      log('info', 'Admin panel dependencies not installed');
      if (!DRY_RUN) {
        const adminDir = path.dirname(Admin_PACKAGE_JSON);
        const result = runCommand('npm install', { cwd: adminDir });
        if (result.success) {
          log('success', 'Admin panel dependencies installed');
        } else {
          log('warn', 'Admin panel dependencies installation failed (non-critical)');
        }
      }
    }
  }

  return issues;
}

// ─── Step 5: Validate Project Structure ─────────────────────────

async function validateStructure() {
  log('info', '\n═══════════════════════════════════════════════════════════');
  log('info', ' STEP 5: Validating Project Structure');
  log('info', '═══════════════════════════════════════════════════════════');

  const issues = [];

  // Check critical directories
  const criticalDirs = ['src', 'dist', 'logs', 'scripts'];
  for (const dir of criticalDirs) {
    const dirPath = path.join(PROJECT_ROOT, dir);
    if (!fs.existsSync(dirPath)) {
      log('warn', `Missing directory: ${dir}`);
      if (!DRY_RUN) {
        fs.mkdirSync(dirPath, { recursive: true });
        log('success', `Created directory: ${dir}`);
      }
    } else {
      log('success', `Directory ${dir} exists ✓`);
    }
  }

  // Check for misplaced files
  const misplacedFiles = [
    { file: 'check-db-ssot.js', should: 'scripts/' },
    { file: 'read-notes.js', should: 'scripts/' },
    { file: 'seed-db.js', should: 'scripts/' },
  ];

  for (const { file, should } of misplacedFiles) {
    const srcPath = path.join(PROJECT_ROOT, file);
    if (fs.existsSync(srcPath)) {
      log('warn', `Misplaced file: ${file} (should be in ${should})`);
      if (!DRY_RUN) {
        const destPath = path.join(PROJECT_ROOT, should, file);
        if (!fs.existsSync(destPath)) {
          fs.renameSync(srcPath, destPath);
          log('success', `Moved ${file} to ${should}`);
        } else {
          log('info', `Destination exists: ${should}${file}`);
        }
      }
    }
  }

  // Check for redundant start.js
  const startJs = path.join(PROJECT_ROOT, 'start.js');
  if (fs.existsSync(startJs)) {
    log('warn', 'Redundant start.js found');
    if (!DRY_RUN) {
      // Keep it but log warning
      log('info', 'start.js kept (consider removing)');
    }
  }

  return issues;
}

// ─── Step 6: Environment File Check ─────────────────────────────

async function checkEnvFiles() {
  log('info', '\n═══════════════════════════════════════════════════════════');
  log('info', ' STEP 6: Checking Environment Files');
  log('info', '═══════════════════════════════════════════════════════════');

  const issues = [];

  const envFile = path.join(PROJECT_ROOT, '.env');
  const envExample = path.join(PROJECT_ROOT, '.env.example');

  if (!fs.existsSync(envFile)) {
    log('warn', '.env file not found');
    if (fs.existsSync(envExample)) {
      if (!DRY_RUN) {
        fs.copyFileSync(envExample, envFile);
        log('success', 'Created .env from .env.example');
        log('warn', 'Please edit .env with your actual values');
      } else {
        log('info', '[DRY RUN] Would create .env from .env.example');
      }
    } else {
      log('error', '.env.example not found');
      issues.push('env_example_missing');
    }
  } else {
    log('success', '.env file exists ✓');
    
    // Check for required variables
    const envContent = fs.readFileSync(envFile, 'utf-8');
    const requiredVars = ['GROQ_API_KEY'];
    const missingVars = requiredVars.filter(v => !envContent.includes(`${v}=`) || envContent.includes(`${v}=\n`));
    
    if (missingVars.length > 0) {
      log('warn', `Missing or empty env vars: ${missingVars.join(', ')}`);
      issues.push('env_vars_missing');
    }
  }

  return issues;
}

// ─── Main Execution ─────────────────────────────────────────────

async function main() {
  console.log('\n🚀 Proxi New — Environment Setup');
  console.log('═══════════════════════════════════════════════════════════════');
  if (DRY_RUN) console.log('⚠️  DRY RUN MODE — No changes will be made\n');

  let allIssues = [];
  let status = 'success';

  try {
    // Step 1: System environment
    allIssues.push(...await checkSystemEnvironment());

    // Step 2: Ports
    allIssues.push(...await checkAndCleanPorts());

    // Step 3: Clean caches
    allIssues.push(...await cleanCaches());

    // Step 4: Dependencies
    allIssues.push(...await checkDependencies());

    // Step 5: Structure
    allIssues.push(...await validateStructure());

    // Step 6: Env files
    allIssues.push(...await checkEnvFiles());

    // Determine final status
    if (allIssues.length > 0) {
      status = allIssues.some(i => i.includes('missing') || i.includes('failed')) ? 'failed' : 'partial';
    }

  } catch (error) {
    log('error', `Unexpected error: ${error.message}`);
    status = 'failed';
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  
  const errors = logEntries.filter(e => e.level === 'error').length;
  const warnings = logEntries.filter(e => e.level === 'warn').length;
  const successes = logEntries.filter(e => e.level === 'success').length;

  console.log(`✅ Successes: ${successes}`);
  console.log(`⚠️  Warnings: ${warnings}`);
  console.log(`❌ Errors: ${errors}`);
  
  if (status === 'success') {
    console.log('\n🎉 Environment is ready!');
  } else if (status === 'partial') {
    console.log('\n⚠️  Environment ready with warnings');
  } else {
    console.log('\n❌ Environment has issues that need attention');
  }

  // Save log
  const logPath = saveLog(status);
  
  console.log('\n═══════════════════════════════════════════════════════════════\n');

  process.exit(status === 'failed' ? 1 : 0);
}

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  saveLog('failed');
  process.exit(1);
});
