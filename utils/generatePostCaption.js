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
const { geminiGenerate } = require('./geminiClient');

const SYSTEM_PROMPT_PATH = path.join(__dirname, '..', 'system_prompt_post.txt');
const TOPIC_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'random_topic_post.txt');

// Read once at module load. Split off the Input Format block so the
// user-turn owns the variable data and the system instruction stays static.
// The new prompt uses a markdown header (`## Input Format`) rather than the
// older `INPUT FORMAT:` line marker, so the split regex matches both.
const RAW_PROMPT = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
const SYSTEM_INSTRUCTION = RAW_PROMPT.split(/^##\s*Input Format|^INPUT FORMAT:/im)[0].trim();

// Topic-based text-post prompt (used by generateTopicPost / publish_text_post).
const RAW_TOPIC_PROMPT = fs.readFileSync(TOPIC_PROMPT_PATH, 'utf8');
const TOPIC_SYSTEM_INSTRUCTION = RAW_TOPIC_PROMPT.split(
  /^##\s*Input Format|^INPUT FORMAT:/im
)[0].trim();

// Thin wrapper over the shared client (utils/geminiClient.js), which owns the
// API-key failover. Keeps this module's voice-variance defaults (higher temp,
// longer output) while the rotation logic lives in one place.
function requestGemini(systemInstruction, userText, options = {}) {
  return geminiGenerate(systemInstruction, userText, {
    temperature: options.temperature ?? 0.95,
    maxTokens: options.maxTokens ?? 300,
  });
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

/**
 * Paraphrase an EXISTING caption into the profile's voice. Same persona/style
 * rules as generatePostCaption (shared system instruction), but the task is to
 * rewrite the given caption — keeping its meaning, vibe, language, and rough
 * length — rather than invent one from the image context.
 *
 * Returns the paraphrased caption on success, or '' on API error / SKIP / empty
 * so the caller can fall back to the original caption as-is.
 *
 * @param {string} userIdentity — the profile's identityPrompt (voice)
 * @param {string} originalCaption — the post's stored caption to rewrite
 * @param {string} [postContext] — optional image description, for grounding
 */
async function paraphrasePostCaption(userIdentity, originalCaption, postContext) {
  try {
    const original = String(originalCaption || '').trim();
    if (!original) return ''; // nothing to paraphrase

    const normalizedIdentity = String(userIdentity || '').trim();
    const normalizedContext = String(postContext || '')
      .replace(/\s+/g, ' ')
      .trim();

    const userText = [
      'TASK: Rewrite (paraphrase) the caption below so it sounds like THIS person',
      'wrote it — their voice, tone, and language. Keep the same overall meaning,',
      'mood, and roughly the same length. Do not translate it to another language.',
      'Output ONLY the rewritten caption, nothing else.',
      '',
      'USER IDENTITY:',
      normalizedIdentity || '(none)',
      '',
      'IMAGE CONTEXT (reference only):',
      normalizedContext || '(none)',
      '',
      'ORIGINAL CAPTION:',
      original,
    ].join('\n');

    console.log(`  [paraphrasePostCaption] original: "${original}"`);

    const payload = await requestGemini(SYSTEM_INSTRUCTION, userText, { temperature: 0.9 });

    const raw = (payload?.candidates?.[0]?.content?.parts?.[0]?.text || '')
      .trim()
      .replace(/^["']|["']$/g, '');

    if (!raw || raw.toUpperCase() === 'SKIP') {
      console.log(`  [paraphrasePostCaption] empty/SKIP — caller will use original caption`);
      return '';
    }

    const caption = raw
      .replace(/[—–]|(?<= )-(?= )/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    console.log(`  [paraphrasePostCaption] paraphrased: "${caption}"`);
    return caption;
  } catch (err) {
    console.warn(`  [paraphrasePostCaption] API error: ${err.message}`);
    return '';
  }
}

/**
 * Generate a SHORT text-only Facebook status from a topic seed, in the user's
 * voice. Uses prompts/random_topic_post.txt as the system instruction.
 *
 * Returns the status text on success, or '' on API error / SKIP / empty so the
 * caller can decide whether to skip the post.
 *
 * @param {string} userIdentity — the profile's identityPrompt (voice)
 * @param {string} topic — the topic seed (from utils/postTopics.pickPostTopic)
 * @param {object} [extra] — optional grounding ({ city, work })
 */
async function generateTopicPost(userIdentity, topic, extra = {}) {
  try {
    const normalizedTopic = String(topic || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalizedTopic) return '';

    const normalizedIdentity = String(userIdentity || '').trim();
    const city = String(extra.city || '').trim();
    const work = String(extra.work || '').trim();

    const userText = [
      'TOPIC:',
      normalizedTopic,
      '',
      'USER IDENTITY:',
      normalizedIdentity || '(none)',
      city ? `\nLOCATION: ${city}` : '',
      work ? `WORK: ${work}` : '',
      '',
      'OUTPUT:',
      'Write ONLY the Facebook status text.',
    ]
      .filter((l) => l !== '')
      .join('\n');

    console.log(`  [generateTopicPost] topic: "${normalizedTopic}"`);

    const payload = await requestGemini(TOPIC_SYSTEM_INSTRUCTION, userText);

    const raw = (payload?.candidates?.[0]?.content?.parts?.[0]?.text || '')
      .trim()
      .replace(/^["']|["']$/g, '');

    if (!raw || raw.toUpperCase() === 'SKIP') {
      console.log(`  [generateTopicPost] empty/SKIP`);
      return '';
    }

    const caption = raw
      .replace(/[—–]|(?<= )-(?= )/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    console.log(`  [generateTopicPost] generated: "${caption}"`);
    return caption;
  } catch (err) {
    console.warn(`  [generateTopicPost] API error: ${err.message}`);
    return '';
  }
}

module.exports = { generatePostCaption, paraphrasePostCaption, generateTopicPost };
