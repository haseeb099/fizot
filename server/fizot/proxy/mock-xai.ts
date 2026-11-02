import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type MockXai = { url: string; close: () => Promise<void>; server: Server; calls: Array<{ path: string; auth: string }> };

/** Local stand-in for xAI: OpenAI-compatible chat completions and responses, streaming included. */
export async function startMockXai(): Promise<MockXai> {
  const calls: MockXai["calls"] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const url = new URL(req.url ?? "/", "http://mock-xai.local");
    calls.push({ path: url.pathname, auth: String(req.headers.authorization ?? "") });
    let body: { stream?: boolean; model?: string } = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as typeof body; } catch { /* empty */ }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [{ delta: { content: "hello" } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: body.model ?? "mock-grok",
        choices: [{ index: 0, message: { role: "assistant", content: "hello from mock xAI" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 6 },
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/responses") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp-mock", object: "response", output_text: "hello from mock xAI responses" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
