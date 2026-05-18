/**
 * generatePostCaption — Gemini API integration for Facebook post captions
 * (used by publish_post). Parallel to generateMessage.js (which serves
 * shares/comments), but with a different system prompt tuned for original
 * post captions — voice-matched to the user identity, 50-reasons fallback
 * for vague image context, no AI-tells, occasional emoji.
 *
 * System instructions live in ../system_prompt_post.txt and are read once
 * at module load. Variable inputs (post context + user identity) are sent
 * in the user turn so the system prompt stays cacheable.
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

const SYSTEM_PROMPT_PATH = path.join(__dirname, '..', 'system_prompt_post.txt');

// Read once at module load. Split off the Input Format block so the
// user-turn owns the variable data and the system instruction stays static.
// The new prompt uses a markdown header (`## Input Format`) rather than the
// older `INPUT FORMAT:` line marker, so the split regex matches both.
const RAW_PROMPT = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
const SYSTEM_INSTRUCTION = RAW_PROMPT.split(/^##\s*Input Format|^INPUT FORMAT:/im)[0].trim();

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
        temperature: options.temperature ?? 0.95,
        maxOutputTokens: options.maxTokens ?? 300,
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

async function generatePostCaption(userIdentity, postContext) {
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
      'Generate ONLY the Facebook caption text.',
    ].join('\n');

    console.log(`  [generatePostCaption] context: "${normalizedContext}"`);

    const payload = await requestGemini(SYSTEM_INSTRUCTION, userText);

    const raw = (payload?.candidates?.[0]?.content?.parts?.[0]?.text || '')
      .trim()
      .replace(/^["']|["']$/g, '');

    if (!raw || raw.toUpperCase() === 'SKIP') {
      console.log(`  [generatePostCaption] empty/SKIP — posting without caption`);
      return '';
    }

    // Same sanitization as generateMessage: collapse em/en dashes and spaced
    // standalone hyphens into a space. In-word hyphens (state-of-the-art)
    // are preserved by the negative lookbehind/ahead on spaces.
    const caption = raw
      .replace(/[—–]|(?<= )-(?= )/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    console.log(`  [generatePostCaption] generated: "${caption}"`);
    return caption;
  } catch (err) {
    console.warn(`  [generatePostCaption] API error: ${err.message}`);
    return '';
  }
}

module.exports = { generatePostCaption };
