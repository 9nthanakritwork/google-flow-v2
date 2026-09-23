/**
 * account_rotator.mjs — Manages Google Flow account selection and credit rotation.
 * 
 * Strict Single-Window Policy:
 * When switching accounts, stops the current Chrome and starts the new account's
 * profile on the same CDP port (9333). Exactly ONE Chrome window on screen at all times.
 */

import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import http from 'http';

const SDK_DIR = '/home/hermes/DEV/api-custom-flow';
const POOL_PATH = path.join(SDK_DIR, 'account_pool.json');
const CMD = process.argv[2] || 'status';

export function loadPool() {
  if (!fs.existsSync(POOL_PATH)) {
    throw new Error(`account_pool.json not found at ${POOL_PATH}`);
  }
  return JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
}

export function savePool(pool) {
  fs.writeFileSync(POOL_PATH, JSON.stringify(pool, null, 2), 'utf8');
}

function resetDailyIfNeeded(pool) {
  const todayStr = new Date().toISOString().slice(0, 10);
  let changed = false;
  for (const acc of pool.accounts) {
    if (acc.last_used_date !== todayStr) {
      acc.credits_used_today = 0;
      acc.last_used_date = todayStr;
      changed = true;
    }
  }
  if (changed) savePool(pool);
}

function httpGetJson(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function waitForCdp(port = 9333, maxRetries = 30) {
  for (let i = 0; i < maxRetries; i++) {
    const res = await httpGetJson(`http://127.0.0.1:${port}/json/version`);
    if (res && res.Browser) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

export function getActiveAccount() {
  const pool = loadPool();
  resetDailyIfNeeded(pool);
  const active = pool.accounts.find(a => a.id === pool.active_account_id);
  return active || pool.accounts[0];
}

export function markAccountQuotaReached(accountId) {
  const pool = loadPool();
  const acc = pool.accounts.find(a => a.id === accountId);
  if (acc) {
    acc.credits_used_today = acc.daily_credit_limit;
    acc.last_used_date = new Date().toISOString().slice(0, 10);
    savePool(pool);
    console.log(`[Rotator] Marked ${accountId} (${acc.email || ''}) as quota reached for today.`);
  }
}

/**
 * Switches the single Chrome window on port 9333 to the target account's profile.
 */
export async function switchChromeToAccount(targetAccount) {
  console.log(`[Rotator] Switching Chrome to ${targetAccount.id} (${targetAccount.email})...`);

  // 1. Gracefully stop current Chrome on port 9333
  try {
    execSync("pkill -TERM -f 'remote-debugging-port=9333'", { stdio: 'ignore' });
  } catch {}
  await new Promise(r => setTimeout(r, 1500));

  // 2. Launch single Chrome window for target account
  const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0' };
  const targetUrl = targetAccount.project_url ||
    (targetAccount.project_id ? `https://flow.google.com/project/${targetAccount.project_id}` : 'https://flow.google.com/');

  const chromeProc = spawn('/opt/google/chrome/chrome', [
    `--user-data-dir=${targetAccount.profile_dir}`,
    '--profile-directory=Default',
    '--remote-debugging-port=9333',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-position=60,40',
    targetUrl
  ], { env, detached: true, stdio: 'ignore' });

  chromeProc.unref();

  // 3. Wait for CDP port 9333 to be ready
  const ready = await waitForCdp(9333, 40);
  if (!ready) {
    throw new Error(`Timeout waiting for Chrome on port 9333 for ${targetAccount.id}`);
  }

  // 4. Update pool active account & port
  const pool = loadPool();
  pool.active_account_id = targetAccount.id;
  for (const a of pool.accounts) {
    a.port = 9333; // Single active port
  }
  savePool(pool);

  console.log(`[Rotator] Chrome successfully switched to ${targetAccount.id} on port 9333!`);
  return targetAccount;
}

/**
 * Selects the next account that has at least requiredCredits remaining.
 */
export async function selectNextAccount(requiredCredits = 15) {
  const pool = loadPool();
  resetDailyIfNeeded(pool);

  // Available ready accounts that have enough credits
  const candidateAccounts = pool.accounts.filter(a =>
    a.status === 'ready' &&
    (a.daily_credit_limit - a.credits_used_today) >= requiredCredits
  );

  if (candidateAccounts.length === 0) {
    console.warn(`[Rotator Warning] No ready accounts with >= ${requiredCredits} credits remaining.`);
    const anyAvailable = pool.accounts.filter(a => a.status === 'ready');
    if (anyAvailable.length === 0) {
      throw new Error('All Google Flow accounts have exhausted their daily credit quota.');
    }
    return anyAvailable[0];
  }

  // If current active account has enough credits, keep it!
  const current = candidateAccounts.find(a => a.id === pool.active_account_id);
  if (current) {
    const rem = current.daily_credit_limit - current.credits_used_today;
    console.log(`[Rotator] Current active account ${current.id} (${current.email}) has ${rem} credits (>= ${requiredCredits} required).`);
    return current;
  }

  // Otherwise pick the next account with the most remaining credits
  candidateAccounts.sort((a, b) =>
    (b.daily_credit_limit - b.credits_used_today) - (a.daily_credit_limit - a.credits_used_today)
  );

  const next = candidateAccounts[0];
  console.log(`[Rotator] Selected next account: ${next.id} (${next.email}) with ${next.daily_credit_limit - next.credits_used_today} credits.`);

  // Switch Chrome to this account cleanly
  await switchChromeToAccount(next);
  return next;
}

export function recordCreditUsage(usedCredits = 15) {
  const pool = loadPool();
  resetDailyIfNeeded(pool);
  const active = pool.accounts.find(a => a.id === pool.active_account_id);
  if (active) {
    active.credits_used_today += parseInt(usedCredits, 10) || 15;
    active.last_used_date = new Date().toISOString().slice(0, 10);
    savePool(pool);
    console.log(`[Rotator] Recorded ${usedCredits} credits used for ${active.id}. Total today: ${active.credits_used_today}/${active.daily_credit_limit}`);
  }
}

// CLI handler
async function main() {
  const pool = loadPool();
  resetDailyIfNeeded(pool);

  if (CMD === 'status') {
    console.log('\n===== GOOGLE FLOW MULTI-ACCOUNT POOL STATUS =====');
    console.log(`Active Account: ${pool.active_account_id}\n`);
    console.table(pool.accounts.map(a => ({
      ID: a.id,
      Email: a.email || '(Not synced)',
      Status: a.status,
      'Credits Used': `${a.credits_used_today} / ${a.daily_credit_limit}`,
      Remaining: a.daily_credit_limit - a.credits_used_today
    })));
  } else if (CMD === 'switch' && process.argv[3]) {
    const target = pool.accounts.find(a => a.id === process.argv[3]);
    if (!target) throw new Error(`Account ${process.argv[3]} not found`);
    await switchChromeToAccount(target);
  } else if (CMD === 'select-next') {
    const next = await selectNextAccount(parseInt(process.argv[3], 10) || 15);
    console.log(`Switched to: ${next.id} (${next.email})`);
  }
}

if (process.argv[1]?.endsWith('account_rotator.mjs')) {
  main().catch(err => {
    console.error('[Rotator CLI Error]', err.message);
    process.exit(1);
  });
}
