/**
 * Smoke-test for utils/generateMessage.js (Gemini).
 *
 * Reads post_context.txt at the repo root with this shape:
 *
 *   POST CONTEXT:
 *   <one or more lines>
 *   USER IDENTITY:
 *   <one or more lines>
 *
 * Calls generateMessage(userIdentity, postContext) and prints the output.
 *
 * Usage:
 *   node scripts/test-generate-message.js
 *   node scripts/test-generate-message.js path/to/other.txt
 */

const fs = require('fs');
const path = require('path');
const { generateMessage } = require('../utils/generateMessage');

function parseContextFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const match = raw.match(/POST CONTEXT:\s*([\s\S]*?)\s*USER IDENTITY:\s*([\s\S]*)$/i);
  if (!match) {
    throw new Error(
      `Could not find "POST CONTEXT:" and "USER IDENTITY:" markers in ${filePath}`
    );
  }
  return {
    postContext: match[1].trim(),
    userIdentity: match[2].trim(),
  };
}

(async () => {
  const inputArg = process.argv[2];
  const filePath = inputArg
    ? path.resolve(inputArg)
    : path.join(__dirname, '..', 'post_context.txt');

  console.log(`[test] reading ${filePath}`);
  const { postContext, userIdentity } = parseContextFile(filePath);

  console.log(`[test] post context (${postContext.length} chars):\n${postContext}\n`);
  console.log(`[test] user identity (${userIdentity.length} chars):\n${userIdentity}\n`);
  console.log(`[test] calling Gemini...`);

  const t0 = Date.now();
  const message = await generateMessage(userIdentity, postContext);
  const ms = Date.now() - t0;

  console.log(`\n[test] ===== RESULT (${ms}ms) =====`);
  if (!message) {
    console.log('(empty — share would proceed silently)');
  } else {
    console.log(message);
  }
})().catch((err) => {
  console.error(`[test] failed: ${err.message}`);
  process.exit(1);
});
