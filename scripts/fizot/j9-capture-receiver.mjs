#!/usr/bin/env node
/**
 * Local Stripe CLI capture receiver for J9. Listens on loopback only.
 *
 *   node --experimental-strip-types scripts/fizot/j9-capture-receiver.mjs
 *   stripe listen --forward-to http://127.0.0.1:18787/stripe \
 *     --events checkout.session.completed,invoice.paid
 *
 * Writes unmodified raw bodies + Stripe-Signature headers under
 * artifacts/j9/inbox/ (gitignored, mode 0700/0600 when the OS supports it).
 * Never prints bodies or signatures. Delete inbox after packing/verification.
 * Oversized bodies (>2 MiB) are rejected and never written.
 */
import { createServer } from "node:http";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ensureCaptureInbox,
  J9_CAPTURE_MAX_BYTES,
  readIncomingMessageBounded,
  writeRestrictedFile,
} from "../../server/fizot/billing/j9-capture-transfer.ts";

const host = "127.0.0.1";
const port = Number(process.env.J9_CAPTURE_PORT ?? 18787);
const inbox = ensureCaptureInbox(process.cwd());

let seq = 0;
const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/stripe") {
    res.writeHead(404).end("not_found");
    return;
  }
  const bodyRead = await readIncomingMessageBounded(req, J9_CAPTURE_MAX_BYTES);
  if (!bodyRead.ok) {
    const status = bodyRead.reason === "capture_transfer_too_large" ? 413 : 400;
    res.writeHead(status).end(bodyRead.reason);
    return;
  }
  const bodyBuf = bodyRead.buffer;
  const body = bodyBuf.toString("utf8");
  const signature = String(req.headers["stripe-signature"] ?? "");
  if (!signature.includes("v1=")) {
    res.writeHead(400).end("missing_signature");
    return;
  }
  if (body.includes("sk_test_") || body.includes("sk_live_") || body.includes("whsec_")) {
    res.writeHead(400).end("secret_material");
    return;
  }
  let type = "unknown";
  try {
    type = String(JSON.parse(body).type ?? "unknown").replace(/[^\w.-]/g, "_");
  } catch {
    res.writeHead(400).end("body_not_json");
    return;
  }
  seq += 1;
  const stamp = `${Date.now()}_${seq}`;
  const base = join(inbox, `${stamp}_${type}`);
  writeRestrictedFile(`${base}.body.json`, bodyBuf);
  writeRestrictedFile(`${base}.sig.txt`, `${signature}\n`);
  const files = readdirSync(inbox).filter((name) => name.endsWith(".body.json"));
  console.error(`j9_capture_receiver saved type=${type} inbox_files=${files.length} (body redacted)`);
  res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
});

server.listen(port, host, () => {
  console.error(`j9_capture_receiver listening http://${host}:${port}/stripe`);
  console.error("j9_capture_receiver forward: stripe listen --forward-to http://127.0.0.1:" + port + "/stripe");
  console.error("j9_capture_receiver inbox=" + inbox);
  console.error("j9_capture_receiver max_body_bytes=" + J9_CAPTURE_MAX_BYTES);
  console.error("j9_capture_receiver cleanup: delete artifacts/j9/inbox and webhook-capture.json after verification");
});
