const REDACTED = "[REDACTED]";

const PATTERNS: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9_.~+/=-]+/gi, `$1 ${REDACTED}`],
  [/(Authorization:\s*token)\s+\S+/gi, `$1 ${REDACTED}`],
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, REDACTED],
  [/(\/\/)[^/\s:@]+(?::[^/\s@]*)?@/g, `$1${REDACTED}@`],
  [/([?&](?:access_)?token=)[^&\s]+/gi, `$1${REDACTED}`],
  [
    /("(?:[a-z_]*token|password|passwd|secret|client_secret|authorization|private_key|key)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    `$1"${REDACTED}"`
  ]
];

const SENSITIVE_KEY = /token|password|passwd|secret|authorization|private_?key|credential/i;

export function redactSensitive(input: string): string {
  return PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    input
  );
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitive(error.message);
  }
  return redactSensitive(String(error));
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 4) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => redactValue(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? REDACTED : redactValue(item, depth + 1)
      ])
    );
  }
  return value;
}

/**
 * Produces a bounded, redacted description of a remote response body that is safe to place in
 * an error message. Values under sensitive-looking keys are replaced and known token forms are
 * removed from whatever remains.
 */
export function describeRemoteBody(raw: string, limit = 300): string {
  if (raw.trim() === "") return "(empty response body)";
  let text: string;
  try {
    text = JSON.stringify(redactValue(JSON.parse(raw) as unknown, 0));
  } catch {
    text = raw.replace(/\s+/g, " ");
  }
  const redacted = redactSensitive(text);
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}
