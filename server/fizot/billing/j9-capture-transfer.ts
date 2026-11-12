/**
 * Secure fetch of a staged J9 webhook-capture.json from a short-lived HTTPS URL.
 * The URL is a bearer credential: supply only via Actions secret, never workflow inputs.
 *
 * Connection safety: resolve DNS once, reject non-public addresses, then pin the undici
 * TCP connect to those addresses while keeping TLS servername/certificate checks on the
 * original hostname (redirects disabled). Body reads are streamed with a hard byte cap.
 */
import { mkdirSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import {
  assertHttpsTransferUrl,
  captureBodyLooksSensitive,
  J9_CAPTURE_INBOX_RELATIVE,
  J9_WEBHOOK_CAPTURE_RELATIVE,
} from "./j9-capture-policy.ts";

export const J9_CAPTURE_TRANSFER_SECRET_NAME = "STRIPE_J9_CAPTURE_TRANSFER_URL";
export const J9_CAPTURE_MAX_BYTES = 2 * 1024 * 1024;
export const J9_CAPTURE_FETCH_TIMEOUT_MS = 30_000;
/** Optional remote upload remains enabled: undici pins connect to validated addresses. */
export const J9_CAPTURE_REMOTE_UPLOAD_ENABLED = true;

export type TransferAddress = { address: string; family: 4 | 6 };

function normalizeIp(ip: string): string {
  return ip.trim().toLowerCase();
}

/** Map ::ffff:… forms onto the embedded IPv4 address when present. */
export function ipv4MappedAddress(ip: string): string | null {
  const v = normalizeIp(ip);
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

export function isBlockedIpAddress(ip: string): boolean {
  const mapped = ipv4MappedAddress(ip);
  if (mapped) return isBlockedIpAddress(mapped);

  const v = normalizeIp(ip);
  if (!v) return true;
  if (v === "::" || v === "0:0:0:0:0:0:0:0") return true;
  if (v === "::1" || v === "0:0:0:0:0:0:0:1") return true;
  if (v.startsWith("fe80:") || v.startsWith("fec0:") || v.startsWith("ff")) return true;
  // Unique local fc00::/7
  if (v.startsWith("fc") || v.startsWith("fd")) return true;

  if (v.includes(".")) {
    const parts = v.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  // Non-mapped IPv6: only public unicast is allowed (already rejected ULA/link-local/loopback).
  return false;
}

export function isBlockedTransferHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "metadata.google.internal" || host === "metadata") return true;
  if (host.endsWith(".internal")) return true;
  const ipVersion = isIP(host);
  if (ipVersion) return isBlockedIpAddress(host);
  return false;
}

export type TransferDnsLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export type ResolvedTransferDestination =
  | { ok: true; hostname: string; addresses: TransferAddress[] }
  | { ok: false; reason: string };

export async function resolveAllowedTransferDestination(
  url: string,
  dnsLookup: TransferDnsLookup = (hostname) => lookup(hostname, { all: true, verbatim: true }),
): Promise<ResolvedTransferDestination> {
  const basic = assertHttpsTransferUrl(url);
  if (!basic.ok) return basic;
  const parsed = new URL(url.trim());
  if (isBlockedTransferHostname(parsed.hostname)) {
    return { ok: false, reason: "capture_transfer_host_blocked" };
  }
  try {
    const records = await dnsLookup(parsed.hostname);
    if (records.length < 1) return { ok: false, reason: "capture_transfer_host_unresolvable" };
    const addresses: TransferAddress[] = [];
    for (const row of records) {
      const family = row.family === 6 ? 6 : 4;
      if (isBlockedIpAddress(row.address)) {
        return { ok: false, reason: "capture_transfer_resolved_address_blocked" };
      }
      addresses.push({ address: row.address, family });
    }
    if (addresses.length < 1) return { ok: false, reason: "capture_transfer_host_unresolvable" };
    return { ok: true, hostname: parsed.hostname, addresses };
  } catch {
    return { ok: false, reason: "capture_transfer_host_unresolvable" };
  }
}

export async function assertTransferDestinationAllowed(
  url: string,
  dnsLookup?: TransferDnsLookup,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const resolved = await resolveAllowedTransferDestination(url, dnsLookup);
  if (!resolved.ok) return resolved;
  return { ok: true };
}

/**
 * Pin TCP connect to previously validated addresses. TLS SNI/certificate checks stay on
 * the original hostname so hostname validation is preserved.
 */
export function createPinnedTransferDispatcher(input: {
  hostname: string;
  addresses: TransferAddress[];
}): Agent {
  const connector = buildConnector({ rejectUnauthorized: true });
  const pinned = input.addresses.filter((row) => !isBlockedIpAddress(row.address));
  if (pinned.length < 1) {
    throw new Error("capture_transfer_resolved_address_blocked");
  }
  return new Agent({
    connect(opts, callback) {
      const requestedHost = String(opts.servername || opts.hostname || "");
      if (
        requestedHost
        && requestedHost !== input.hostname
        && requestedHost !== pinned[0].address
        && !pinned.some((row) => row.address === requestedHost)
      ) {
        callback(new Error("capture_transfer_host_mismatch"), null);
        return;
      }
      const preferred =
        pinned.find((row) => row.family === 4)
        ?? pinned.find((row) => row.family === 6)
        ?? pinned[0];
      if (isBlockedIpAddress(preferred.address)) {
        callback(new Error("capture_transfer_resolved_address_blocked"), null);
        return;
      }
      connector(
        {
          ...opts,
          hostname: preferred.address,
          servername: input.hostname,
        },
        callback,
      );
    },
  });
}

export function restrictPathMode(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Windows may ignore POSIX modes; still create the file.
  }
}

export function ensureRestrictedDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  restrictPathMode(path, 0o700);
}

export function writeRestrictedFile(path: string, contents: string | Buffer): void {
  ensureRestrictedDir(dirname(path));
  writeFileSync(path, contents, { mode: 0o600 });
  restrictPathMode(path, 0o600);
}

export type BoundedReadResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; reason: "capture_transfer_too_large" | "capture_transfer_empty" | "capture_transfer_body_read_failed" };

/**
 * Stream a fetch body with an immediate abort once maxBytes is exceeded.
 */
export async function readResponseBodyBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  contentLengthHeader: string | null,
): Promise<BoundedReadResult> {
  if (contentLengthHeader != null && contentLengthHeader !== "") {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, reason: "capture_transfer_too_large" };
    }
  }
  if (!body) return { ok: false, reason: "capture_transfer_empty" };
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength < 1) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "capture_transfer_too_large" };
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: "capture_transfer_body_read_failed" };
  }
  if (total < 2) return { ok: false, reason: "capture_transfer_empty" };
  return { ok: true, buffer: Buffer.concat(chunks, total) };
}

/**
 * Bounded read for the loopback Stripe CLI receiver (same 2 MiB policy).
 */
export async function readIncomingMessageBounded(
  req: IncomingMessage,
  maxBytes: number,
): Promise<BoundedReadResult> {
  const declared = req.headers["content-length"];
  if (typeof declared === "string" && declared !== "") {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      req.resume();
      return { ok: false, reason: "capture_transfer_too_large" };
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) {
        req.destroy();
        return { ok: false, reason: "capture_transfer_too_large" };
      }
      chunks.push(buf);
    }
  } catch {
    return { ok: false, reason: "capture_transfer_body_read_failed" };
  }
  if (total < 1) return { ok: false, reason: "capture_transfer_empty" };
  return { ok: true, buffer: Buffer.concat(chunks, total) };
}

export type FetchCaptureResult =
  | { ok: true; bytes: number; path: string }
  | { ok: false; reason: string };

function parseAndValidateCaptureText(text: string): { ok: true } | { ok: false; reason: string } {
  if (captureBodyLooksSensitive(text)) {
    return { ok: false, reason: "capture_transfer_sensitive_material" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "capture_transfer_not_json" };
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "capture_transfer_schema_invalid" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== 2 || obj.kind !== "stripe_cli_signed_capture") {
    return { ok: false, reason: "capture_transfer_schema_invalid" };
  }
  return { ok: true };
}

/**
 * Download capture to the fixed J9 path. Disables redirects. Never logs the URL or body.
 * Production path pins TCP to DNS-validated addresses via undici.
 */
export async function fetchCaptureFromTransferUrl(input: {
  url: string;
  repoRoot?: string;
  /** Test seam only: bypasses undici pin. Production must omit this. */
  fetchImpl?: typeof fetch;
  dnsLookup?: TransferDnsLookup;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<FetchCaptureResult> {
  if (!J9_CAPTURE_REMOTE_UPLOAD_ENABLED && !input.fetchImpl) {
    return { ok: false, reason: "capture_transfer_remote_upload_disabled" };
  }

  const root = input.repoRoot ?? process.cwd();
  const outPath = resolve(root, J9_WEBHOOK_CAPTURE_RELATIVE);
  const maxBytes = input.maxBytes ?? J9_CAPTURE_MAX_BYTES;
  const timeoutMs = input.timeoutMs ?? J9_CAPTURE_FETCH_TIMEOUT_MS;
  const dnsLookup = input.dnsLookup;

  const wipeCapture = (): void => {
    try {
      unlinkSync(outPath);
    } catch {
      // absent is fine
    }
  };
  wipeCapture();

  const resolved = await resolveAllowedTransferDestination(input.url, dnsLookup);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let dispatcher: Agent | null = null;
  try {
    let res: Response;
    if (input.fetchImpl) {
      res = await input.fetchImpl(input.url.trim(), {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
    } else {
      dispatcher = createPinnedTransferDispatcher({
        hostname: resolved.hostname,
        addresses: resolved.addresses,
      });
      res = await undiciFetch(input.url.trim(), {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json" },
        dispatcher,
      }) as unknown as Response;
    }

    if (!res.ok) {
      wipeCapture();
      return { ok: false, reason: `capture_transfer_http_${res.status}` };
    }
    const finalUrl = res.url || input.url.trim();
    if (!finalUrl.startsWith("https://")) {
      wipeCapture();
      return { ok: false, reason: "capture_transfer_redirect_not_https" };
    }
    // Redirects are disabled; still re-check the reported URL host against the pinned set.
    try {
      const finalHost = new URL(finalUrl).hostname;
      if (finalHost !== resolved.hostname) {
        wipeCapture();
        return { ok: false, reason: "capture_transfer_host_mismatch" };
      }
    } catch {
      wipeCapture();
      return { ok: false, reason: "capture_transfer_url_invalid" };
    }

    const bodyRead = await readResponseBodyBounded(
      res.body,
      maxBytes,
      res.headers.get("content-length"),
    );
    if (!bodyRead.ok) {
      wipeCapture();
      return { ok: false, reason: bodyRead.reason };
    }
    const text = bodyRead.buffer.toString("utf8");
    const validated = parseAndValidateCaptureText(text);
    if (!validated.ok) {
      wipeCapture();
      return { ok: false, reason: validated.reason };
    }
    writeRestrictedFile(outPath, `${text.endsWith("\n") ? text : `${text}\n`}`);
    return { ok: true, bytes: bodyRead.buffer.byteLength, path: outPath };
  } catch (error) {
    wipeCapture();
    const message = error instanceof Error ? error.message : "";
    const name = error instanceof Error ? error.name : "";
    if (message.includes("capture_transfer_resolved_address_blocked")) {
      return { ok: false, reason: "capture_transfer_resolved_address_blocked" };
    }
    if (message.includes("capture_transfer_host_mismatch")) {
      return { ok: false, reason: "capture_transfer_host_mismatch" };
    }
    if (name === "AbortError") return { ok: false, reason: "capture_transfer_timeout" };
    return { ok: false, reason: "capture_transfer_fetch_failed" };
  } finally {
    clearTimeout(timer);
    if (dispatcher) {
      try {
        await dispatcher.close();
      } catch {
        // ignore close races
      }
    }
  }
}

export function ensureCaptureInbox(repoRoot = process.cwd()): string {
  const inbox = resolve(repoRoot, J9_CAPTURE_INBOX_RELATIVE);
  ensureRestrictedDir(inbox);
  return inbox;
}
