/**
 * geminiClient — single source of truth for calling Gemini, with automatic
 * API-key failover.
 *
 * The free Gemini tier has a per-minute / per-day quota. When a batch of
 * profiles publishes posts (or generates share messages) in a tight window,
 * the quota gets exhausted and every call comes back 429 RESOURCE_EXHAUSTED.
 * Today that makes publish_post fall back to the original (English) caption.
 *
 * This client tries a list of keys in order. On a quota / rate-limit /
 * overload / bad-key error it rotates to the next key and retries the SAME
 * request; on a clearly non-retryable error (e.g. a malformed body) it throws
 * immediately so we don't waste the backup keys' quota.
 *
 * Configure keys in .env, any of these (combined + de-duped, in this order):
 *   GEMINI_API_KEY=key1            ← primary (may itself be comma-separated)
 *   GEMINI_API_KEY_2=key2          ← backups, numbered 2..9
 *   GEMINI_API_KEY_3=key3
 *   GEMINI_API_KEYS=key4,key5      ← optional explicit comma-separated list
 *
 * GEMINI_MODEL (default gemini-flash-lite-latest) is shared across all keys.
 */

require('dotenv').config();

const GEMINI_URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Ordered, de-duped list of API keys to try. Primary first, then backups.
 */
function resolveGeminiKeys() {
  const keys = [];
  const push = (val) => {
    String(val || '')
      .split(',')
      .forEach((k) => {
        const t = k.trim();
        if (t) keys.push(t);
      });
  };

  push(process.env.GEMINI_API_KEY);
  for (let i = 2; i <= 9; i++) push(process.env[`GEMINI_API_KEY_${i}`]);
  push(process.env.GEMINI_API_KEYS);

  return [...new Set(keys)];
}

/**
 * Should we fail over to the next key on this error? True for quota /
 * rate-limit / overload / transient / bad-or-blocked-key errors — anything
 * where a DIFFERENT key might succeed. False for request-shape errors (a
 * different key wouldn't help), so we throw fast instead of burning backups.
 */
function isFailoverGeminiError(status, detail) {
  if (status === 429 || status === 500 || status === 503) return true;
  return /quota|rate.?limit|exceeded|high demand|overloaded|try again later|resource_exhausted|api[_ ]?key|permission|unauthor|forbidden/i.test(
    String(detail || '')
  );
}

/**
 * Pull the human-useful bits out of a Gemini error body. The top-line
 * `error.message` on a 429 is always the generic "You exceeded your current
 * quota" — it never says WHICH quota (RPD vs RPM vs TPM). The specific limit
 * lives in `error.details[]`: a `QuotaFailure` carries the `quotaId` (e.g.
 * `GenerateRequestsPerMinutePerProjectPerModel-FreeTier`) and a `RetryInfo`
 * carries `retryDelay`. Surfacing both turns "exceeded your quota" into
 * "exceeded your quota [quota: ...PerMinute...; retry in 37s]" so the logs
 * tell you whether to add a backup key (daily cap) or slow the fleet down
 * (per-minute cap).
 */
function describeQuota(errBody) {
  try {
    const details = errBody?.error?.details;
    if (!Array.isArray(details)) return '';

    const quotaIds = [];
    let retry = '';
    for (const d of details) {
      const type = String(d?.['@type'] || '');
      if (type.includes('QuotaFailure') && Array.isArray(d.violations)) {
        for (const v of d.violations) {
          const id = v?.quotaId || v?.quotaMetric;
          if (id) quotaIds.push(id);
        }
      } else if (type.includes('RetryInfo') && d.retryDelay) {
        retry = String(d.retryDelay);
      }
    }

    const parts = [];
    if (quotaIds.length) parts.push(`quota: ${[...new Set(quotaIds)].join(', ')}`);
    if (retry) parts.push(`retry in ${retry}`);
    return parts.length ? ` [${parts.join('; ')}]` : '';
  } catch {
    return '';
  }
}

/**
 * Make a generateContent call, rotating through the configured keys on
 * quota/transient/key errors. Returns the parsed JSON payload on success,
 * throws after every key has been exhausted (or on the first non-failover
 * error).
 *
 * @param {string} systemInstruction
 * @param {string} userText
 * @param {{temperature?: number, maxTokens?: number}} [options]
 */
async function geminiGenerate(systemInstruction, userText, options = {}) {
  const keys = resolveGeminiKeys();
  const model = String(process.env.GEMINI_MODEL || 'gemini-flash-lite-latest').trim();

  if (keys.length === 0) throw new Error('Missing GEMINI_API_KEY in environment.');

  const url = `${GEMINI_URL_BASE}/${model}:generateContent`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.9,
      maxOutputTokens: options.maxTokens ?? 200,
    },
  });

  let lastErr;
  for (let i = 0; i < keys.length; i++) {
    const hasBackup = i < keys.length - 1;

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys[i] },
        body,
      });
    } catch (err) {
      // Network-level failure — a different key won't fix it, but the next
      // attempt might catch a transient blip. Try the next key if we have one.
      lastErr = new Error(`Gemini request failed: ${err.message}`);
      if (hasBackup) {
        console.warn(
          `  [gemini] key #${i + 1} network error (${err.message}) — trying backup key #${i + 2}`
        );
        continue;
      }
      throw lastErr;
    }

    if (response.ok) {
      if (i > 0) console.log(`  [gemini] backup key #${i + 1} succeeded`);
      return await response.json();
    }

    let detail = `HTTP ${response.status}`;
    try {
      const errBody = await response.json();
      detail = (errBody?.error?.message || JSON.stringify(errBody)) + describeQuota(errBody);
    } catch {}
    lastErr = new Error(`Gemini request failed: ${detail}`);

    if (hasBackup && isFailoverGeminiError(response.status, detail)) {
      console.warn(
        `  [gemini] key #${i + 1} failed (${detail.slice(0, 80)}) — trying backup key #${i + 2}`
      );
      continue;
    }

    // Either no backup left, or a non-failover error (e.g. bad request body) —
    // a different key wouldn't help. Throw now.
    throw lastErr;
  }

  throw lastErr || new Error('Gemini request failed: no API keys available');
}

module.exports = { geminiGenerate, resolveGeminiKeys, isFailoverGeminiError };
