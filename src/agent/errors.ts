/**
 * Turning API failures into something a human can act on.
 *
 * A quota error mid demo should not dump raw JSON at a judge. These are the
 * failures that actually happen with a Gemini key, each with the fix.
 *
 * Nothing here ever includes the API key, and the raw error is only shown when
 * we do not recognise it.
 */

/** Pull the status code out of whatever shape the SDK threw. */
function statusCode(raw: string): number | null {
  const match = raw.match(/"code"\s*:\s*(\d+)/);
  return match?.[1] ? Number(match[1]) : null;
}

/** Which quotas the API said were exceeded. */
function quotaIds(raw: string): string[] {
  return [...raw.matchAll(/"quotaId"\s*:\s*"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((id): id is string => id !== undefined);
}

/** Groq tags its own failures, so we can give provider specific advice. */
function isGroq(raw: string): boolean {
  return /"provider"\s*:\s*"groq"/.test(raw);
}

/**
 * Explain an error from the model call, or return null if we do not recognise
 * it and the caller should just show the original.
 */
export function explainApiError(error: unknown, model: string): string | null {
  const raw = error instanceof Error ? error.message : String(error);
  const code = statusCode(raw);

  if (isGroq(raw)) return explainGroqError(raw, code, model);

  if (code === 429) {
    const ids = quotaIds(raw);
    const perDay = ids.some((id) => id.includes("PerDay"));
    const lines = [
      `The Gemini API refused the call: you are over quota on ${model}.`,
      "",
      "Quotas reported as exceeded:",
      ...ids.map((id) => `  - ${id}`),
      "",
    ];

    if (perDay) {
      lines.push(
        "The per DAY free tier quota is used up, so waiting a few minutes will not help.",
        "",
        "Your options:",
        "  1. Enable billing on the Google Cloud project behind this key, which lifts",
        "     the free tier caps. This is the quickest fix.",
        "  2. Use a key from a different Google Cloud project, which gets its own quota.",
        "  3. Wait for the daily reset (midnight Pacific Time) and run it again.",
      );
    } else {
      lines.push(
        "This is the per minute limit, so waiting about a minute and running it again",
        "should work. Free tier allows only a handful of requests per minute, and one",
        "agent run makes several.",
      );
    }

    lines.push(
      "",
      `You can also try a different model by setting GEMINI_MODEL in .env, for`,
      `example GEMINI_MODEL=gemini-2.0-flash. Quotas are counted per model.`,
    );
    return lines.join("\n");
  }

  if (code === 403) {
    return [
      `The Gemini API denied access to ${model} for this project.`,
      "",
      "The key itself is being accepted, so this is a project level restriction on",
      "that model rather than a bad key.",
      "",
      "Your options:",
      "  1. Set a different model in .env, for example:",
      "       GEMINI_MODEL=gemini-2.0-flash",
      "  2. Use a key from a different Google Cloud project.",
      "  3. Check the project at https://aistudio.google.com/apikey",
    ].join("\n");
  }

  if (code === 400 && /API key not valid/i.test(raw)) {
    return [
      "The Gemini API rejected the key as invalid.",
      "",
      "Check the GEMINI_API_KEY line in .env. It should be the key exactly as issued,",
      "with no quotes, no spaces and no trailing characters.",
      "Get a fresh one at https://aistudio.google.com/apikey",
    ].join("\n");
  }

  if (code === 503 || code === 500) {
    return [
      `The Gemini API had a server error (${code}) on ${model}.`,
      "This is on their side. Running it again usually works.",
    ].join("\n");
  }

  return null;
}

/** The failures that actually happen against Groq, each with the fix. */
function explainGroqError(raw: string, code: number | null, model: string): string {
  const detail = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1];

  if (code === 429) {
    // Quote the limit Groq actually reported. Hardcoding numbers here would be
    // wrong, they differ per model and per tier.
    const tpm = raw.match(/tokens per minute \(TPM\): Limit (\d+)/i)?.[1];
    const rpm = raw.match(/requests per minute \(RPM\): Limit (\d+)/i)?.[1];
    const rpd = raw.match(/requests per day \(RPD\): Limit (\d+)/i)?.[1];

    const limits: string[] = [];
    if (tpm) limits.push(`  tokens per minute: ${tpm}`);
    if (rpm) limits.push(`  requests per minute: ${rpm}`);
    if (rpd) limits.push(`  requests per day: ${rpd}`);

    return [
      `Groq rate limited the call on ${model}, and the automatic waits were not`,
      "enough to get under the limit.",
      ...(detail ? ["", `  ${detail}`] : []),
      ...(limits.length > 0 ? ["", "The limit Groq reported for this model:", ...limits] : []),
      "",
      "An agent run makes several calls and the conversation grows every turn, so",
      "the tokens per minute ceiling is usually what you hit, not the request count.",
      "A reasoning model burns through it fastest.",
      "",
      "Your options:",
      "  1. Wait a minute and run it again. Per minute limits clear quickly.",
      "  2. Use a model with a higher token allowance, for example",
      "       GROQ_MODEL=llama-3.3-70b-versatile",
      "  3. Check current usage at https://console.groq.com/settings/limits",
    ].join("\n");
  }

  if (code === 401) {
    return [
      "Groq rejected the API key.",
      "",
      "Check the GROQ_API_KEY line in .env. It should be the key exactly as issued",
      "(they start with gsk_), with no quotes, no spaces and no trailing characters.",
      "Get a fresh one at https://console.groq.com/keys",
    ].join("\n");
  }

  if (code === 404) {
    return [
      `Groq does not recognise the model "${model}".`,
      ...(detail ? ["", `  ${detail}`] : []),
      "",
      "Set GROQ_MODEL in .env to a model that is currently served, for example:",
      "  GROQ_MODEL=llama-3.3-70b-versatile",
      "",
      "The current list is at https://console.groq.com/docs/models",
    ].join("\n");
  }

  if (code === 400) {
    return [
      `Groq rejected the request as malformed on ${model}.`,
      ...(detail ? ["", `  ${detail}`] : []),
      "",
      "This usually means the model does not support tool calling. Pick one that",
      "does, for example GROQ_MODEL=llama-3.3-70b-versatile",
    ].join("\n");
  }

  if (code === 503 || code === 500) {
    return [
      `Groq had a server error (${code}) on ${model}.`,
      "This is on their side. Running it again usually works.",
    ].join("\n");
  }

  return [
    `Groq returned an error (${code ?? "unknown status"}) on ${model}.`,
    ...(detail ? ["", `  ${detail}`] : []),
    "",
    "Check the key and the model name in .env, and the service status at",
    "https://groqstatus.com",
  ].join("\n");
}
