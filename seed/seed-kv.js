const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Template seed script — seeds KV with anonymized examples.
// For real data, use the seed-kv.js in your private data repo.
const ROOT = path.join(__dirname, '..');
const BINDING = 'PCP';

function kvPut(key, filePath) {
  execSync(`npx wrangler kv key put --binding ${BINDING} "${key}" --path "${filePath}"`, {
    stdio: 'inherit',
    cwd: ROOT,
  });
}

// Seed core (template) and active (example) from files
const files = {
  core: path.join(__dirname, 'core.yaml'),
  active: path.join(__dirname, 'active.template.json'),
};

for (const [key, file] of Object.entries(files)) {
  if (!fs.existsSync(file)) {
    console.error(`Warning: ${file} not found, skipping ${key}`);
    continue;
  }
  kvPut(key, file);
  console.log(`  seeded: ${key}`);
}

// Seed empty changelog and review_queue
const emptyPath = path.join(os.tmpdir(), 'pcp-empty.json');
fs.writeFileSync(emptyPath, '[]');

kvPut('changelog', emptyPath);
console.log('  seeded: changelog');

kvPut('review_queue', emptyPath);
console.log('  seeded: review_queue');

fs.unlinkSync(emptyPath);

console.log('\nSeeded 4 keys with template data.');
console.log('To seed with real data, use the seed-kv.js in your private data repo.');
