#!/usr/bin/env node
/**
 * Extended Mind V1 → V2 migration script.
 *
 * Usage:
 *   node seed/migrate-v2.js --export              # export current active from production KV
 *   node seed/migrate-v2.js --dry-run              # convert V1→V2, output to stdout (no KV write)
 *   node seed/migrate-v2.js --import <file> --backup  # write V2 to KV (backup V1 first)
 *   node seed/migrate-v2.js --rollback             # restore V1 from backup
 *
 * Requires: wrangler CLI authenticated, run from project root.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

const BINDING = 'PCP';
const ENTRY_TTL_DAYS = 30;

// --- Placeholder detection ---
const PLACEHOLDER_PATTERNS = [
  /^single current/i,
  /^a concrete/i,
  /^a valid/i,
  /^single coherent/i,
  /^a complete/i,
  /or omission$/i,
];

function isPlaceholder(value) {
  if (typeof value !== 'string') return false;
  return PLACEHOLDER_PATTERNS.some(p => p.test(value.trim()));
}

// --- Key name pollution detection ---
function isPollutedKey(key) {
  return key.includes(' ') || key.includes('"') || key.includes("'");
}

// --- KV operations via wrangler CLI ---
function kvGet(key) {
  try {
    const result = execSync(
      `npx wrangler kv key get --binding ${BINDING} --remote "${key}"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return result;
  } catch {
    return null;
  }
}

function kvPut(key, value) {
  const tmpFile = `/tmp/migrate-v2-${key.replace(/[^a-z0-9]/gi, '_')}.json`;
  writeFileSync(tmpFile, value);
  execSync(
    `npx wrangler kv key put --binding ${BINDING} --remote "${key}" --path "${tmpFile}"`,
    { encoding: 'utf-8', stdio: 'inherit' }
  );
}

function kvDelete(key) {
  try {
    execSync(
      `npx wrangler kv key delete --binding ${BINDING} --remote "${key}" --force`,
      { encoding: 'utf-8', stdio: 'inherit' }
    );
  } catch { /* ignore */ }
}

// --- Conversion ---
function convertV1toV2(v1Active) {
  const entries = [];
  const skipped = [];
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ENTRY_TTL_DAYS * 24 * 3600 * 1000).toISOString();

  // Flatten the nested V1 object
  function processObject(obj, prefix = '') {
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      // Skip sessions (stored separately in KV)
      if (key === 'sessions') continue;

      // Skip polluted key names
      if (isPollutedKey(key)) {
        skipped.push({ key: fullKey, reason: 'polluted_key', value: typeof value === 'string' ? value.slice(0, 80) : typeof value });
        continue;
      }

      // Skip context.context.* (triple nesting duplicates)
      if (fullKey.startsWith('context.context.')) {
        skipped.push({ key: fullKey, reason: 'triple_nesting', value: typeof value === 'string' ? value.slice(0, 80) : typeof value });
        continue;
      }

      // Skip top_of_mind (removed in V2)
      if (key === 'top_of_mind') {
        skipped.push({ key: fullKey, reason: 'top_of_mind_removed', value: typeof value === 'string' ? value.slice(0, 80) : typeof value });
        continue;
      }

      if (typeof value === 'string') {
        if (isPlaceholder(value)) {
          skipped.push({ key: fullKey, reason: 'placeholder', value: value.slice(0, 80) });
          continue;
        }
        // Simple key-value → 1 entry
        const data = prefix ? `${fullKey}: ${value}` : (key.startsWith('brid_') ? `BRID-${key.slice(5)}: ${value}` : `${key}: ${value}`);
        entries.push({
          id: randomUUID(),
          date: now,
          data,
          tag: 'active',
          expires_at: expiresAt,
        });
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        entries.push({
          id: randomUUID(),
          date: now,
          data: `${fullKey}: ${value}`,
          tag: 'active',
          expires_at: expiresAt,
        });
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // Check if this is a "colleague" object (has role or name sub-keys)
        const subKeys = Object.keys(value);
        const isPersonProfile = subKeys.some(k => ['role', 'name', 'email', 'communication', 'base'].includes(k));

        if (isPersonProfile) {
          // Merge person attributes into one entry
          const parts = [];
          for (const [sk, sv] of Object.entries(value)) {
            if (typeof sv === 'string' && !isPlaceholder(sv)) {
              parts.push(`${sk}: ${sv}`);
            }
          }
          if (parts.length > 0) {
            const data = `${key}: ${parts.join('. ')}`;
            entries.push({
              id: randomUUID(),
              date: now,
              data,
              tag: 'active',
              expires_at: expiresAt,
            });
          }
        } else {
          processObject(value, fullKey);
        }
      } else if (Array.isArray(value)) {
        // Array values → join as single entry
        const data = `${fullKey}: ${JSON.stringify(value)}`;
        if (data.length <= 500) {
          entries.push({
            id: randomUUID(),
            date: now,
            data,
            tag: 'active',
            expires_at: expiresAt,
          });
        }
      }
    }
  }

  processObject(v1Active);

  return { entries, conflicts: [], skipped };
}

// --- CLI ---
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case '--export': {
    const raw = kvGet('active');
    if (!raw) {
      console.error('No active data found in KV');
      process.exit(1);
    }
    process.stdout.write(raw);
    break;
  }

  case '--dry-run': {
    const raw = kvGet('active');
    if (!raw) {
      console.error('No active data found in KV');
      process.exit(1);
    }
    const v1 = JSON.parse(raw);
    if (Array.isArray(v1.entries)) {
      console.error('Active is already V2 format');
      process.exit(1);
    }
    const result = convertV1toV2(v1);
    console.error(`Entries: ${result.entries.length}`);
    console.error(`Skipped: ${result.skipped.length}`);
    console.error('\nSkipped items:');
    for (const s of result.skipped) {
      console.error(`  [${s.reason}] ${s.key}: ${s.value}`);
    }
    // Output V2 JSON to stdout
    process.stdout.write(JSON.stringify({ entries: result.entries, conflicts: result.conflicts }, null, 2));
    break;
  }

  case '--import': {
    const filePath = args[1];
    if (!filePath) {
      console.error('Usage: --import <file> [--backup]');
      process.exit(1);
    }
    const doBackup = args.includes('--backup');

    if (doBackup) {
      console.log('Backing up current active to active_v1_backup...');
      const current = kvGet('active');
      if (current) {
        kvPut('active_v1_backup', current);
        console.log('Backup saved.');
      }
    }

    const v2Data = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(v2Data);
    if (!Array.isArray(parsed.entries)) {
      console.error('Invalid V2 format: missing entries array');
      process.exit(1);
    }

    console.log(`Writing V2 active: ${parsed.entries.length} entries, ${(parsed.conflicts || []).length} conflicts`);
    kvPut('active', JSON.stringify(parsed));

    // Invalidate cache
    kvDelete('cache:response');
    console.log('Cache invalidated. Migration complete.');
    break;
  }

  case '--rollback': {
    console.log('Restoring from active_v1_backup...');
    const backup = kvGet('active_v1_backup');
    if (!backup) {
      console.error('No backup found (active_v1_backup)');
      process.exit(1);
    }
    kvPut('active', backup);
    kvDelete('cache:response');
    console.log('Rollback complete.');
    break;
  }

  default:
    console.error(`Usage:
  node seed/migrate-v2.js --export
  node seed/migrate-v2.js --dry-run
  node seed/migrate-v2.js --import <file> --backup
  node seed/migrate-v2.js --rollback`);
    process.exit(1);
}
