import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CapBook } from "./caps.ts";
import { Ledger } from "./ledger.ts";
import { redactLogLine } from "./redact.ts";
import { TokenStore } from "./tokens.ts";

export type ProxyOptions = {
  upstreamBase: string;
  upstreamKey?: string;
  log?: (line: string) => void;
  defaultCap?: number;
};

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
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
  const tokens = new TokenStore();
  const ledger = new Ledger();
  const caps = new CapBook();
  const log = (line: string) => options.log?.(redactLogLine(line));
  const defaultCap = options.defaultCap ?? 1_000_000;

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
        const record = token ? tokens.authorize(token, undefined) : null;
        if (!record) return sendJson(res, 401, { error: { message: "invalid token" } });
        return sendJson(res, 200, {
          object: "list",
          data: [{ object: "model", id: "mock-grok", display_name: "Mock Grok" }],
        });
      }
      if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/responses")) {
        const token = bearer(req);
        const record = token ? tokens.authorize(token, undefined) : null;
        if (!record) return sendJson(res, 401, { error: { message: "invalid token" } });
        const raw = await readBody(req);
        log(`proxy ${url.pathname} instance=${record.instanceId} bytes=${raw.byteLength}`);
        let parsed: { stream?: boolean; model?: string } = {};
        try { parsed = JSON.parse(raw.toString("utf8")) as typeof parsed; } catch { /* forward as-is */ }
        const requestId = String(req.headers["x-request-id"] ?? `${record.instanceId}-${Date.now()}`);
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
      log(`error ${error instanceof Error ? error.message : String(error)}`);
      sendJson(res, 500, { error: { message: "proxy error" } });
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
