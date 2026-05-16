/**
 * Profile Vault Logs dashboard client.
 *
 * Posts to the vault server so the Logs page in Profile Vault shows live
 * activity. All errors are swallowed — the bot must never block on or
 * crash from the dashboard. See log.md for the endpoint contract.
 */

const axios = require('axios');

const VAULT_URL = process.env.VAULT_URL || 'http://localhost:4000';
const VAULT_ENABLED = String(process.env.VAULT_ENABLED || 'false').toLowerCase() === 'true';
const TIMEOUT_MS = 3000;

const ts = () => new Date().toTimeString().slice(0, 8);

function normalizeLine(line) {
  if (line == null) return null;
  if (typeof line === 'string') return { ts: ts(), level: 'info', msg: line };
  if (!line.msg) return null;
  return { ts: ts(), level: 'info', ...line };
}

async function post(path, body) {
  if (!VAULT_ENABLED) return; // dashboard logging off — see VAULT_ENABLED in .env
  try {
    await axios.post(`${VAULT_URL}${path}`, body, {
      timeout: TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (_) {
    // Intentional silence — vault availability never affects the bot.
  }
}

const vaultLog = {
  task: (t) => post('/api/logs/task', { startedAt: Date.now(), ...t }),
  browser: (state, lines = []) => {
    const logs = (Array.isArray(lines) ? lines : [lines]).map(normalizeLine).filter(Boolean);
    return post('/api/logs/browser', { ...state, logs });
  },
  done: (profileId) => post('/api/logs/processed', { profileId }),
  reset: () => post('/api/logs/reset', {}),
};

module.exports = { vaultLog };
