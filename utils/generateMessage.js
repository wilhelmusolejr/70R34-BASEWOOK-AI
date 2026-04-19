/**
 * generateMessage — GitHub Models API integration for generating Facebook share messages.
 * Returns plain text ready to type into the share dialog.
 * Returns empty string on any failure so the share proceeds silently.
 *
 * Required env vars (set in .env):
 *   GITHUB_MODELS_TOKEN       - GitHub personal access token with Models access
 *   GITHUB_MODELS_MODEL       - model name (default: openai/gpt-4.1)
 *   GITHUB_MODELS_BASE_URL    - API endpoint
 *   GITHUB_MODELS_API_VERSION - API version header
 */

require('dotenv').config();

async function requestGitHubModels(messages, options = {}) {
  const token = String(process.env.GITHUB_MODELS_TOKEN || '').trim();
  const model = String(process.env.GITHUB_MODELS_MODEL || 'openai/gpt-4.1').trim();
  const endpoint = String(process.env.GITHUB_MODELS_BASE_URL || 'https://models.github.ai/inference/chat/completions').trim();
  const apiVersion = String(process.env.GITHUB_MODELS_API_VERSION || '2026-03-10').trim();

  if (!token) throw new Error('Missing GITHUB_MODELS_TOKEN in environment.');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': apiVersion
    },
    body: JSON.stringify({
      model,
      temperature: options.temperature ?? 0.8,
      max_tokens: options.maxTokens ?? 100,
      messages
    })
  });

  if (!response.ok) {
    let errorMessage = `GitHub Models request failed (HTTP ${response.status}).`;
    try {
      const body = await response.json();
      const detail = body?.message || body?.error?.message || JSON.stringify(body);
      errorMessage = `HTTP ${response.status}: ${detail}`;
    } catch {}
    throw new Error(errorMessage);
  }

  return await response.json();
}

async function generateMessage(userIdentity, postContext) {
  try {
    const normalizedContext = String(postContext || '').replace(/\s+/g, ' ').trim();

    const systemPrompt = `
      USER PERSONA: ${userIdentity}

      TASK:
      1. Analyze the "Post Context" to determine the appropriate mood (e.g., excited, cynical, helpful, amused, or shocked).
      2. Write a Facebook comment or opinion in the "USER PERSONA" typing style, as if reacting to the post.

      CONSTRAINTS:
      - LANGUAGE: Detect the country or region from the USER PERSONA (e.g. "from Manila" → Filipino/Tagalog, "from Jakarta" → Indonesian, "from Sacramento" → English, "from Paris" → French). Write the message in the native language of that location. If no location is mentioned, default to English.
      - VARIETY: Never start with "Check this out", "Pretty cool", "Wow", or "Interesting."
      - TYPING STYLE: Match how a real person types in that language. Use casual, natural phrasing — not textbook-formal. Include local slang or expressions if it fits the persona.
      - DYNAMIC RESPONSE: If the post is news, react to the news. If it's a product, react to the utility. If it's a joke, react to the humor. If it's an opinion, agree or push back.
      - LENGTH: Minimum 5 words. Maximum 20 words.
      - OUTPUT: Plain text only. No quotes, no hashtags, no labels.
      - SKIP: Only return the word SKIP (nothing else) if the post context is completely empty, is random characters/codes, or contains no readable human language. If there is any readable text or image description, always generate a message.
      - NO HYPHENS: Do not use em dashes (—), en dashes (–), or long hyphens (-) in your response. Use commas, periods, or just rewrite the sentence instead.
    `.trim();

    console.log(`  [generateMessage] context: "${normalizedContext}"`);

    const payload = await requestGitHubModels([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Post Context: ${normalizedContext}\n\nGenerate the share message:` }
    ]);

    const raw = payload.choices[0]?.message?.content?.trim().replace(/^["']|["']$/g, '') ?? '';
    if (!raw || raw === 'SKIP') {
      console.log(`  [generateMessage] not enough context, sharing without message`);
      return '';
    }

    // Sanitize: replace em dash, en dash, and standalone hyphens with a space
    const message = raw.replace(/[—–]|(?<= )-(?= )/g, ' ').replace(/\s{2,}/g, ' ').trim();

    console.log(`  [generateMessage] generated: "${message}"`);
    return message;

  } catch (err) {
    console.warn(`  [generateMessage] API error: ${err.message}`);
    return '';
  }
}

module.exports = { generateMessage };
