// Loopback HTTP CONNECT proxy that records every CONNECT host and absolute-form HTTP host.
import { createServer } from "node:http";
import { connect } from "node:net";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * @param {string} logPath
 * @returns {Promise<{ url: string, close: () => Promise<void>, hosts: () => string[] }>}
 */
export function startLoggingProxy(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, "", "utf8");
  const seen = new Set();

  const record = (host, kind) => {
    const key = host.toLowerCase();
    if (!key) return;
    seen.add(key);
    appendFileSync(logPath, `${JSON.stringify({ t: new Date().toISOString(), kind, host: key })}\n`, "utf8");
  };

  const server = createServer((req, res) => {
    const hostHeader = String(req.headers.host ?? "");
    try {
      const target = new URL(req.url ?? "/", `http://${hostHeader || "invalid"}`);
      record(target.hostname, "http");
    } catch {
      record(hostHeader.split(":")[0] ?? "", "http");
    }
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("spike-a proxy does not forward plain HTTP; use CONNECT");
  });

  server.on("connect", (req, clientSocket, head) => {
    const authority = String(req.url ?? "");
    const host = authority.split(":")[0] ?? "";
    record(host, "connect");
    const port = Number(authority.split(":")[1] ?? "443") || 443;
    const upstream = connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("proxy has no port"));
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        hosts: () => [...seen].sort(),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
    server.on("error", reject);
  });
}
