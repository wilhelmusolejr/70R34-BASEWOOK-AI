/**
 * Claude API helper for generating contextual post messages.
 * API generation is currently disabled — generateShareMessage returns '' always.
 * To enable: npm install @anthropic-ai/sdk, set ANTHROPIC_API_KEY, and uncomment below.
 */

// const Anthropic = require('@anthropic-ai/sdk');
// let client = null;
// function getClient() {
//   if (!client) {
//     if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
//     client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
//   }
//   return client;
// }

/**
 * Extract post context from a post element (feed) or full page (specific post).
 * Returns a combined string of text content + image alt.
 */
async function extractPostContext(page, containerElement = null) {
  if (containerElement) {
    // Search within the specific post container using .// (relative to element, not document root)
    const textEl = await containerElement.$('xpath=.//div[@data-ad-rendering-role="story_message"]//div[@dir="auto"]');
    const postText = textEl ? await textEl.innerText().catch(() => '') : '';

    const imgEl = await containerElement.$('xpath=.//img[@data-imgperflogname="feedImage"]');
    const imageAlt = imgEl ? await imgEl.getAttribute('alt').catch(() => '') : '';

    const subEl = await containerElement.$('xpath=.//span[@data-ad-rendering-role="description"]');
    const subText = subEl ? await subEl.innerText().catch(() => '') : '';

    const parts = [postText, subText, imageAlt ? `[Image: ${imageAlt}]` : ''].filter(Boolean);
    return parts.join('\n').trim();
  }

  // Full page search (for share_post with specific URL)
  const textEl = await page.$('xpath=//div[@data-ad-rendering-role="story_message"]//div[@dir="auto"]');
  const postText = textEl ? await textEl.innerText().catch(() => '') : '';

  const imgEl = await page.$('xpath=//img[@data-imgperflogname="feedImage"]');
  const imageAlt = imgEl ? await imgEl.getAttribute('alt').catch(() => '') : '';

  const subEl = await page.$('xpath=//span[@data-ad-rendering-role="description"]');
  const subText = subEl ? await subEl.innerText().catch(() => '') : '';

  const parts = [postText, subText, imageAlt ? `[Image: ${imageAlt}]` : ''].filter(Boolean);
  return parts.join('\n').trim();
}

/**
 * Generate a share message using Claude API.
 * Currently stubbed — returns '' until API is enabled.
 */
async function generateShareMessage(postContext, userIdentity, instruction) {
  // TODO: uncomment when ready to enable Claude API generation
  // try {
  //   const claude = getClient();
  //   const prompt = postContext
  //     ? `You are: ${userIdentity}\n\nPost content:\n${postContext}\n\n${instruction}`
  //     : `You are: ${userIdentity}\n\n${instruction}`;
  //   const response = await claude.messages.create({
  //     model: 'claude-haiku-4-5-20251001',
  //     max_tokens: 150,
  //     messages: [{ role: 'user', content: prompt }]
  //   });
  //   return response.content[0].text.trim();
  // } catch (err) {
  //   console.warn('Claude API failed, sharing without message:', err.message);
  //   return '';
  // }
  return '';
}

module.exports = { extractPostContext, generateShareMessage };
