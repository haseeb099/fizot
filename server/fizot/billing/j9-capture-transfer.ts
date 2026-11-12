/**
 * Secure fetch of a staged J9 webhook-capture.json from a short-lived HTTPS URL.
 * The URL is a bearer credential: supply only via Actions secret, never workflow inputs.
 */
import { mkdirSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  assertHttpsTransferUrl,
  captureBodyLooksSensitive,
  J9_CAPTURE_INBOX_RELATIVE,
  J9_WEBHOOK_CAPTURE_RELATIVE,
} from "./j9-capture-policy.ts";

export const J9_CAPTURE_TRANSFER_SECRET_NAME = "STRIPE_J9_CAPTURE_TRANSFER_URL";
export const J9_CAPTURE_MAX_BYTES = 2 * 1024 * 1024;
export const J9_CAPTURE_FETCH_TIMEOUT_MS = 30_000;

export function isBlockedIpAddress(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  if (v === "::1" || v === "0:0:0:0:0:0:0:1") return true;
  if (v.startsWith("fe80:") || v.startsWith("fc") || v.startsWith("fd")) return true;
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
  }
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

export async function assertTransferDestinationAllowed(
  url: string,
  dnsLookup: TransferDnsLookup = (hostname) => lookup(hostname, { all: true, verbatim: true }),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const basic = assertHttpsTransferUrl(url);
  if (!basic.ok) return basic;
  const parsed = new URL(url.trim());
  if (isBlockedTransferHostname(parsed.hostname)) {
    return { ok: false, reason: "capture_transfer_host_blocked" };
  }
  try {
    const records = await dnsLookup(parsed.hostname);
    if (records.length < 1) return { ok: false, reason: "capture_transfer_host_unresolvable" };
    for (const row of records) {
      if (isBlockedIpAddress(row.address)) {
        return { ok: false, reason: "capture_transfer_resolved_address_blocked" };
      }
    }
  } catch {
    return { ok: false, reason: "capture_transfer_host_unresolvable" };
  }
  return { ok: true };
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

export type FetchCaptureResult =
  | { ok: true; bytes: number; path: string }
  | { ok: false; reason: string };

/**
 * Download capture to the fixed J9 path. Disables redirects. Never logs the URL or body.
 */
export async function fetchCaptureFromTransferUrl(input: {
  url: string;
  repoRoot?: string;
  fetchImpl?: typeof fetch;
  dnsLookup?: TransferDnsLookup;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<FetchCaptureResult> {
  const root = input.repoRoot ?? process.cwd();
  const outPath = resolve(root, J9_WEBHOOK_CAPTURE_RELATIVE);
  const maxBytes = input.maxBytes ?? J9_CAPTURE_MAX_BYTES;
  const timeoutMs = input.timeoutMs ?? J9_CAPTURE_FETCH_TIMEOUT_MS;
  const fetchImpl = input.fetchImpl ?? fetch;
  const dnsLookup = input.dnsLookup;

  const wipeCapture = (): void => {
    try {
      unlinkSync(outPath);
    } catch {
      // absent is fine
    }
  };
  // Never leave a prior capture looking like a successful transfer.
  wipeCapture();

  const allowed = await assertTransferDestinationAllowed(input.url, dnsLookup);
  if (!allowed.ok) return { ok: false, reason: allowed.reason };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(input.url.trim(), {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      wipeCapture();
      return { ok: false, reason: `capture_transfer_http_${res.status}` };
    }
    const finalUrl = res.url || input.url.trim();
    if (!finalUrl.startsWith("https://")) {
      wipeCapture();
      return { ok: false, reason: "capture_transfer_redirect_not_https" };
    }
    const finalCheck = await assertTransferDestinationAllowed(finalUrl, dnsLookup);
    if (!finalCheck.ok) {
      wipeCapture();
      return { ok: false, reason: finalCheck.reason };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 2) {
      wipeCapture();
      return { ok: false, reason: "capture_transfer_empty" };
    }
    if (buf.byteLength > maxBytes) {
      wipeCapture();
      return { ok: false, reason: "capture_transfer_too_large" };
    }
    const text = buf.toString("utf8");
    if (captureBodyLooksSensitive(text)) {
      wipeCapture();
      return { ok: false, reason: "capture_transfer_sensitive_material" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      wipeCapture();
      return { ok: false, reason: "capture_transfer_not_json" };
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      wipeCapture();
      return { ok: false, reason: "capture_transfer_schema_invalid" };
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.schemaVersion !== 2 || obj.kind !== "stripe_cli_signed_capture") {
      wipeCapture();
      return { ok: false, reason: "capture_transfer_schema_invalid" };
    }
    writeRestrictedFile(outPath, `${text.endsWith("\n") ? text : `${text}\n`}`);
    return { ok: true, bytes: buf.byteLength, path: outPath };
  } catch (error) {
    wipeCapture();
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError") return { ok: false, reason: "capture_transfer_timeout" };
    return { ok: false, reason: "capture_transfer_fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}

export function ensureCaptureInbox(repoRoot = process.cwd()): string {
  const inbox = resolve(repoRoot, J9_CAPTURE_INBOX_RELATIVE);
  ensureRestrictedDir(inbox);
  return inbox;
}
