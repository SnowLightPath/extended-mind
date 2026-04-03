const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Real-data seed script — reads data from a private data repo (MyMind).
// Lives in ExtendedMind; uses ExtendedMind's wrangler.toml for Cloudflare KV operations.
//
// Usage:
//   node seed/seed-kv-real.js --data-dir /path/to/MyMind/seed
//   node seed/seed-kv-real.js --data-dir /path/to/MyMind/seed --core-only

const EM_ROOT = path.join(__dirname, '..');
const BINDING = 'PCP';

// Resolve --data-dir argument
const dataDirArgIndex = process.argv.indexOf('--data-dir');
if (dataDirArgIndex === -1 || !process.argv[dataDirArgIndex + 1]) {
  console.error('Error: --data-dir <path> is required');
  console.error('Example: node seed/seed-kv-real.js --data-dir ~/Dashboard/MyMind/seed');
  process.exit(1);
}
const SEED_DIR = path.resolve(process.argv[dataDirArgIndex + 1]);

if (!fs.existsSync(SEED_DIR)) {
  console.error('Error: data-dir not found:', SEED_DIR);
  process.exit(1);
}

function kvPut(key, filePath) {
  execSync(
    `npx wrangler kv key put --binding ${BINDING} "${key}" --path "${filePath}"`,
    { stdio: 'inherit', cwd: EM_ROOT },
  );
}

// Parse args
const args = process.argv.slice(2);
const coreOnly = args.includes('--core-only');

if (coreOnly) {
  // Sync only core.yaml to KV
  kvPut('core', path.join(SEED_DIR, 'core.yaml'));
  console.log('  synced: core');
  console.log('\nDone. Only core was updated.');
} else {
  // Full seed — initial setup only
  const files = {
    core: path.join(SEED_DIR, 'core.yaml'),
    active: path.join(SEED_DIR, 'active.template.json'),
  };

  for (const [key, file] of Object.entries(files)) {
    if (!fs.existsSync(file)) {
      console.error(`Warning: ${file} not found, skipping ${key}`);
      continue;
    }
    kvPut(key, file);
    console.log(`  seeded: ${key}`);
  }

  console.log('\nSeeded 2 keys: core, active');
  console.log('WARNING: This resets all KV keys. Use --core-only for core updates.');
}
