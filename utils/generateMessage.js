/**
 * generateMessage — Gemini API integration for Facebook share/comment messages.
 *
 * System instructions live in ./system_prompt.txt at the repo root and are read
 * once at module load. Variable inputs (post context + user identity) are sent
 * in the user turn so the static system prompt remains cacheable.
 *
 * Required env vars (set in .env):
 *   GEMINI_API_KEY  - API key from https://aistudio.google.com/apikey
 *   GEMINI_MODEL    - model id (default: gemini-flash-lite-latest)
 *
 * Returns plain string on success, '' on failure or when the model says SKIP.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const SYSTEM_PROMPT_PATH = path.join(__dirname, '..', 'system_prompt.txt');

// Read once at module load. Split off the INPUT FORMAT block so the user-turn
// owns the variable data — the system instruction stays static.
const RAW_PROMPT = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
const SYSTEM_INSTRUCTION = RAW_PROMPT.split(/^INPUT FORMAT:/m)[0].trim();

async function requestGemini(systemInstruction, userText, options = {}) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const model = String(process.env.GEMINI_MODEL || 'gemini-flash-lite-latest').trim();

  if (!apiKey) throw new Error('Missing GEMINI_API_KEY in environment.');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: {
        temperature: options.temperature ?? 0.9,
        maxOutputTokens: options.maxTokens ?? 200,
      },
    }),
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      detail = body?.error?.message || JSON.stringify(body);
    } catch {}
    throw new Error(`Gemini request failed: ${detail}`);
  }

  return await response.json();
}

async function generateMessage(userIdentity, postContext) {
  try {
    const normalizedContext = String(postContext || '')
      .replace(/\s+/g, ' ')
      .trim();
    const normalizedIdentity = String(userIdentity || '').trim();

    const userText = [
      'POST CONTEXT:',
      normalizedContext || '(none)',
      '',
      'USER IDENTITY:',
      normalizedIdentity || '(none)',
      '',
      'OUTPUT:',
      'Generate ONLY the Facebook response text.',
    ].join('\n');

    console.log(`  [generateMessage] context: "${normalizedContext}"`);

    const payload = await requestGemini(SYSTEM_INSTRUCTION, userText);

    const raw = (payload?.candidates?.[0]?.content?.parts?.[0]?.text || '')
      .trim()
      .replace(/^["']|["']$/g, '');

    if (!raw || raw.toUpperCase() === 'SKIP') {
      console.log(`  [generateMessage] not enough context, sharing without message`);
      return '';
    }

    // Sanitize: replace em dash, en dash, and standalone hyphens with a space
    const message = raw
      .replace(/[—–]|(?<= )-(?= )/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    console.log(`  [generateMessage] generated: "${message}"`);
    return message;
  } catch (err) {
    console.warn(`  [generateMessage] API error: ${err.message}`);
    return '';
  }
}

module.exports = { generateMessage };
