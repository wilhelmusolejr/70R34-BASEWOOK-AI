// generate-share-message.js
//
// Calls the GitHub Models API to generate a Facebook share post message
// based on the user's identity and the post context.
//
// Usage:
//   const { generateShareMessage } = require("./utils/generate-share-message");
//   const message = await generateShareMessage(userIdentity, postContext);
//
// Required env vars:
//   GITHUB_MODELS_TOKEN        - GitHub personal access token with Models access
//   GITHUB_MODELS_MODEL        - model name (default: openai/gpt-4.1)
//   GITHUB_MODELS_BASE_URL     - API endpoint (default: https://models.github.ai/inference/chat/completions)
//   GITHUB_MODELS_API_VERSION  - API version header (default: 2026-03-10)
//
// Returns:
//   A plain string - the share message only, ready to be typed into the
//   Facebook share dialog. Empty string on failure (share proceeds silently).

require("dotenv").config();

async function requestGitHubModels(messages, options = {}) {
  const token = String(
    process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN || "",
  ).trim();
  const model = String(
    process.env.GITHUB_MODELS_MODEL || "openai/gpt-4.1",
  ).trim();
  const endpoint = String(
    process.env.GITHUB_MODELS_BASE_URL ||
      "https://models.github.ai/inference/chat/completions",
  ).trim();
  const apiVersion = String(
    process.env.GITHUB_MODELS_API_VERSION || "2026-03-10",
  ).trim();

  if (!token) {
    throw new Error("Missing GITHUB_MODELS_TOKEN in environment.");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": apiVersion,
    },
    body: JSON.stringify({
      model,
      temperature: options.temperature ?? 0.8,
      max_tokens: options.maxTokens ?? 100,
      messages,
    }),
  });

  if (!response.ok) {
    let errorMessage = "GitHub Models request failed.";
    try {
      const body = await response.json();
      errorMessage = body?.message || body?.error?.message || errorMessage;
    } catch {
      // ignore body parse failures
    }
    throw new Error(errorMessage);
  }

  return {
    model,
    payload: await response.json(),
  };
}

async function generateShareMessage(userIdentity, postContext) {
  try {
    const normalizedPostContext = String(postContext || "")
      .replace(/\s+/g, " ")
      .trim();
    const systemPrompt = `
      USER PERSONA: ${userIdentity}
      
      TASK:
      1. Analyze the "Post Context" to determine the appropriate mood (e.g., excited, cynical, helpful, amused, or shocked).
      2. Write a Facebook comment or opinion in the "USER PERSONA" typing style, as if reacting to the post.
      
      CONSTRAINTS:
      - VARIETY: Never start with "Check this out", "Pretty cool", "Wow", or "Interesting."
      - TYPING STYLE: Match how a real person types. If the persona is casual, use lowercase, occasional slang, or sentence fragments. Avoid "AI enthusiasm."
      - DYNAMIC RESPONSE: If the post is news, react to the news. If it's a product, react to the utility. If it's a joke, react to the humor. If it's an opinion, agree or push back.
      - LENGTH: Minimum 5 words. Maximum 20 words.
      - OUTPUT: Plain text only. No quotes, no hashtags, no "Mood: [Mood]", no labels.
    `.trim();

    console.log(
      `[generate-share-message] Post context: "${normalizedPostContext}"`,
    );

    const { payload } = await requestGitHubModels([
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Post Context: ${normalizedPostContext}\n\nGenerate the share message:`,
      },
    ]);

    // Clean up any stray quotes the AI might include
    const message =
      payload.choices[0]?.message?.content
        ?.trim()
        .replace(/^["']|["']$/g, "") ?? "";
    console.log(`[generate-share-message] Generated: "${message}"`);
    return message;
  } catch (err) {
    console.warn(`[generate-share-message] API error: ${err.message}`);
    return "";
  }
}
module.exports = { generateShareMessage };
