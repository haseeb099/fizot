const KEY = /\b(omb_ai_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]+)\b/gi;
const PROMPT = /"(?:prompt|content|input|messages)"\s*:\s*/i;

/** Strip bearer tokens and obvious key material from a log line. Never keep prompts. */
export function redactLogLine(line: string): string {
  if (PROMPT.test(line) && line.includes("{")) return "[redacted request body]";
  return line.replace(KEY, "[redacted]");
}

/** Also strip exact secret values (provider keys) that the regex does not name. */
export function redactSecrets(line: string, secrets: readonly string[] = []): string {
  let out = redactLogLine(line);
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

export function assertNoSecrets(line: string, secrets: readonly string[] = []): void {
  if (KEY.test(line)) throw new Error("log line still contains a secret");
  for (const secret of secrets) {
    if (secret.length >= 8 && line.includes(secret)) throw new Error("log line still contains a secret");
  }
}
