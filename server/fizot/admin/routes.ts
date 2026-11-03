import type { IncomingMessage, ServerResponse } from "node:http";
import { safeLogLine } from "./redact.ts";
import type { PlanId } from "./plans.ts";
import type { AdminServices } from "./workspaces.ts";
import type { TeamRole } from "../../cloud-team.ts";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function statusOf(error: unknown): number {
  if (error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  return 500;
}

export function createAdminHandler(services: AdminServices): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://admin.local");
      const method = (req.method ?? "GET").toUpperCase();

      if (method === "POST" && url.pathname === "/admin/workspaces") {
        const body = await readJson(req) as {
          plan?: string;
          ownerEmail?: string;
          teamId?: string;
          teamName?: string;
        };
        if (body.plan !== "home" && body.plan !== "team") {
          send(res, 400, { error: "unknown_plan" });
          return;
        }
        const record = await services.createWorkspace({
          plan: body.plan as PlanId,
          ownerEmail: body.ownerEmail,
          teamId: body.teamId,
          teamName: body.teamName,
        });
        // Never echo the bootstrap secret back to API clients in the skeleton.
        const { bootstrapSecret: _secret, ...publicRecord } = record;
        void _secret;
        send(res, 201, { ok: true, workspace: publicRecord });
        return;
      }

      const match = /^\/admin\/workspaces\/([^/]+)\/(health|power|pairing)$/.exec(url.pathname);
      if (match) {
        const id = decodeURIComponent(match[1]!);
        const action = match[2]!;
        if (action === "health" && method === "GET") {
          const result = await services.workspaceHealth(id);
          send(res, result.status, result.body);
          return;
        }
        if (action === "power" && method === "GET") {
          const result = await services.workspacePower(id);
          send(res, result.status, result.body);
          return;
        }
        if (action === "pairing" && method === "POST") {
          const body = await readJson(req) as {
            label?: string;
            ttlSeconds?: number;
            member?: { email: string; role: TeamRole };
          };
          const result = await services.workspacePairing(id, body);
          send(res, result.status === 200 ? 200 : result.status, result.body);
          return;
        }
      }

      send(res, 404, { error: "not_found" });
    } catch (error) {
      console.error(safeLogLine("admin-error", { message: error instanceof Error ? error.message : String(error) }));
      send(res, statusOf(error), { error: error instanceof Error ? error.message : "error" });
    }
  };
}
