const SECRET_KEYS = [
  "OMB_CLOUD_BOOTSTRAP_SECRET",
  "bootstrapSecret",
  "secret",
  "token",
  "credential",
  "authorization",
  "x-omb-cloud-signature",
];

const SECRET_VALUE = /(?:omb_pair_|v1=)[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{43,}/g;

/** Strip secrets from values destined for logs. Never returns the original secret string. */
export function redactForLog(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[redacted]");
  if (Array.isArray(value)) return value.map(redactForLog);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.some((name) => key.toLowerCase().includes(name.toLowerCase()))) {
        out[key] = "[redacted]";
      } else {
        out[key] = redactForLog(entry);
      }
    }
    return out;
  }
  return value;
}

export function safeLogLine(prefix: string, value: unknown): string {
  return `${prefix} ${JSON.stringify(redactForLog(value))}`;
}
