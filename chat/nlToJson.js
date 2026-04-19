/**
 * nlToJson — Converts natural language into a BASEWOOK automation task JSON.
 * Uses Claude API with the action schemas as the contract.
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const actionSchemas = require('../schemas/actionSchemas');

let client = null;

function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in .env');
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

function buildSchemaReference() {
  return Object.entries(actionSchemas).map(([type, schema]) => {
    const params = Object.entries(schema.params || {}).map(([name, p]) => {
      const parts = [`${name} (${p.type})`];
      if (p.required) parts.push('required');
      if (p.default !== undefined) parts.push(`default: ${JSON.stringify(p.default)}`);
      if (p.enum) parts.push(`options: ${p.enum.join('|')}`);
      if (p.description) parts.push(p.description);
      return `    - ${parts.join(' — ')}`;
    }).join('\n');

    return [
      `ACTION: ${type}`,
      `  Description: ${schema.description}`,
      `  Can have child steps: ${schema.hasChildren}`,
      params ? `  Params:\n${params}` : `  Params: none`
    ].join('\n');
  }).join('\n\n');
}

const SYSTEM_PROMPT = `
You are a BASEWOOK automation task builder. Your only job is to convert a natural language instruction into a valid JSON task object for the automation platform.

TASK SHAPE:
{
  "taskId": "short-kebab-case-id",
  "browsers": <number of browser profiles to use>,
  "concurrency": <max running at once — defaults to browsers value>,
  "blockMedia": <true to block images/video/fonts for speed, false if task uploads images>,
  "steps": [ <array of step objects> ]
}

STEP SHAPE:
{
  "type": "<action name>",
  "params": { <action params> },
  "steps": [ <child steps — only for actions where hasChildren is true> ]
}

RULES:
- Return ONLY raw valid JSON — no markdown fences, no explanation, nothing else
- taskId must be a short descriptive kebab-case string based on the task
- browsers defaults to 1 if the user does not specify
- concurrency defaults to the browsers value if not specified
- blockMedia defaults to true — set false only if the task involves uploading images (setup_avatar, setup_cover)
- Navigators (hasChildren: true) contain child steps that act on the page they navigate to
- Leaf actions (hasChildren: false) never have a steps array
- Never invent action types — only use the actions listed below
- If the user mentions sharing posts with a persona or identity, put the persona in userIdentity param

AVAILABLE ACTIONS:
${buildSchemaReference()}
`.trim();

/**
 * Convert a natural language instruction into a task JSON object.
 *
 * @param {string} userMessage - The natural language instruction
 * @returns {Promise<object>} - Parsed task JSON
 */
async function nlToJson(userMessage) {
  const claude = getClient();

  const response = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: userMessage }
    ]
  });

  const raw = response.content[0]?.text?.trim() ?? '';

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Claude returned invalid JSON:\n${raw}`);
  }
}

module.exports = { nlToJson };
