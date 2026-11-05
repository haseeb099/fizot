import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { signAlertBody } from "../admin/alerts.ts";
import type { AddressInfo } from "node:net";
import { CapBook } from "./caps.ts";
import type { CreditStore } from "./credit-store.ts";
import { Ledger } from "./ledger.ts";
import {
  createRateLimiter,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  meterCompletion,
  type SoftAlertEvent,
} from "./meter.ts";
import { TIER_PRICES, type TierPrice } from "./pricing.ts";
import { redactLogLine, redactSecrets } from "./redact.ts";
import { TokenStore } from "./tokens.ts";

export type ProxyOptions = {
  upstreamBase: string;
  upstreamKey?: string;
  log?: (line: string) => void;
  defaultCap?: number;
  /** When set, chat completions use reserve-then-settle instead of the Spike B token cap. */
  credit?: CreditStore;
  prices?: readonly TierPrice[];
  rateLimitPerMinute?: number;
  onSoftAlert?: (event: SoftAlertEvent) => Promise<void>;
  now?: () => number;
  /** Share Admin's token store so a minted workspace token authorises here. */
  tokens?: TokenStore;
};

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function postSoftAlert(event: SoftAlertEvent): Promise<void> {
  const url = process.env.FIZOT_ALERT_WEBHOOK_URL?.trim();
  if (!url) return;
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-fizot-timestamp": timestamp,
  };
  const secret = process.env.FIZOT_ALERT_WEBHOOK_SECRET?.trim();
  if (secret) headers["x-fizot-signature"] = signAlertBody(secret, timestamp, body);
  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`credit_alert_failed:${res.status}`);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(payload);
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

export type FizotProxy = {
  url: string;
  tokens: TokenStore;
  ledger: Ledger;
  caps: CapBook;
  close: () => Promise<void>;
  server: Server;
};

export async function startFizotProxy(options: ProxyOptions): Promise<FizotProxy> {
  const tokens = options.tokens ?? new TokenStore();
  const ledger = new Ledger();
  const caps = new CapBook();
  const secrets = options.upstreamKey ? [options.upstreamKey] : [];
  const log = (line: string) => options.log?.(redactSecrets(redactLogLine(line), secrets));
  const defaultCap = options.defaultCap ?? 1_000_000;
  const limiter = options.credit
    ? createRateLimiter(options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE)
    : null;
  const hideKeys = (body: string) => {
    let out = body;
    for (const value of secrets) {
      if (value.length >= 8) out = out.split(value).join("[redacted]");
    }
    return out;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://proxy.local");
      if (req.method === "POST" && url.pathname === "/internal/mint") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { instanceId?: string; ttlSeconds?: number };
        const minted = tokens.mint({ instanceId: String(body.instanceId ?? ""), ttlSeconds: Number(body.ttlSeconds ?? 3600) });
        caps.setLimit(String(body.instanceId), caps.state(String(body.instanceId))?.limit ?? defaultCap);
        log(`mint instance=${body.instanceId} id=${minted.id}`);
        return sendJson(res, 200, minted);
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/internal/tokens/")) {
        const id = url.pathname.slice("/internal/tokens/".length);
        const ok = tokens.revoke(id);
        log(`revoke id=${id} ok=${ok}`);
        return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "not found" });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        const token = bearer(req);
        const record = token ? await Promise.resolve(tokens.authorize(token, undefined)) : null;
        if (!record) return sendJson(res, 401, { error: { message: "invalid token" } });
        if (options.credit) {
          return sendJson(res, 200, {
            object: "list",
            data: (options.prices ?? TIER_PRICES).map((tier) => ({
              object: "model",
              id: tier.tier,
              display_name: tier.displayName,
            })),
          });
        }
        return sendJson(res, 200, {
          object: "list",
          data: [
            { object: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
            { object: "model", id: "mock-grok", display_name: "Mock Grok" },
          ],
        });
      }
      if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/responses")) {
        const token = bearer(req);
        const record = token ? await Promise.resolve(tokens.authorize(token, undefined)) : null;
        if (!record) return sendJson(res, 401, { error: { message: "invalid token" } });
        const raw = await readBody(req);
        log(`proxy ${url.pathname} instance=${record.instanceId} bytes=${raw.byteLength}`);
        let parsed: { stream?: boolean; model?: string } = {};
        try { parsed = JSON.parse(raw.toString("utf8")) as typeof parsed; } catch { /* forward as-is */ }
        const requestId = String(req.headers["x-request-id"] ?? `${record.instanceId}-${Date.now()}`);
        if (options.credit && limiter) {
          let parsedBody: { stream?: boolean; model?: string; tier?: string; max_tokens?: number; max_completion_tokens?: number } = {};
          try { parsedBody = JSON.parse(raw.toString("utf8")) as typeof parsedBody; } catch { /* priced from the raw size */ }
          const tier = String(parsedBody.tier ?? parsedBody.model ?? "");
          const outcome = await meterCompletion({
            credit: options.credit,
            workspaceId: record.instanceId,
            requestId,
            tier,
            rawBody: raw,
            parsed: parsedBody,
            prices: options.prices,
            now: options.now?.(),
            rateLimiter: limiter,
            onSoftAlert: options.onSoftAlert ?? postSoftAlert,
            redactBody: hideKeys,
            forward: async (providerBody) => {
              const upstreamUrl = `${options.upstreamBase.replace(/\/+$/, "")}${url.pathname}`;
              const upstream = await fetch(upstreamUrl, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${options.upstreamKey ?? "mock-upstream-key"}`,
                  "x-request-id": requestId,
                },
                body: new Uint8Array(providerBody),
              });
              const upstreamBody = Buffer.from(await upstream.arrayBuffer());
              return {
                status: upstream.status,
                contentType: upstream.headers.get("content-type") ?? "application/json",
                body: upstreamBody,
              };
            },
          });
          log(`proxy ${url.pathname} instance=${record.instanceId} status=${outcome.status} bytes=${raw.byteLength}`);
          res.writeHead(outcome.status, {
            "content-type": outcome.contentType,
            ...outcome.headers,
          });
          res.end(outcome.body);
          return;
        }
        const usageTokens = 26;
        const used = ledger.usage(record.instanceId);
        const decision = caps.decide(record.instanceId, usageTokens, used);
        if (!decision.ok) return sendJson(res, decision.status, decision.body);
        ledger.record({ instanceId: record.instanceId, requestId, tokens: usageTokens });
        const headers: Record<string, string> = {};
        if (decision.alert) headers["x-fizot-cap-alert"] = "80";

        const upstreamUrl = `${options.upstreamBase.replace(/\/+$/, "")}${url.pathname}`;
        const upstream = await fetch(upstreamUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.upstreamKey ?? "mock-upstream-key"}`,
            "x-request-id": requestId,
          },
          body: raw,
        });
        if (parsed.stream) {
          res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/event-stream", ...headers });
          if (upstream.body) {
            for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) res.write(chunk);
          }
          res.end();
          return;
        }
        const text = await upstream.text();
        res.writeHead(upstream.status, { "content-type": "application/json", ...headers });
        res.end(text);
        return;
      }
      sendJson(res, 404, { error: { message: "not found" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`error ${redactSecrets(message, secrets)}`);
      sendJson(res, 500, { error: { message: hideKeys(`proxy error ${message}`) } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    tokens,
    ledger,
    caps,
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
