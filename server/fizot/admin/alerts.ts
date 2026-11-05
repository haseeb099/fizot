/**
 * Deletion overdue alerts (P4.2 review): webhook + GitHub issue.
 * Bodies carry workspace id hash and steps only — never email or other PII.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DeletionAlert } from "./deletion.ts";
import type { DeletionReceipt } from "./store.ts";

export type AlertChannelConfig = {
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  /** owner/repo for GitHub issues (e.g. haseeb099/fizot). */
  githubRepository?: string | null;
  githubToken?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export function alertChannelsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const webhook = Boolean(env.FIZOT_ALERT_WEBHOOK_URL?.trim());
  const github = Boolean(env.GITHUB_TOKEN?.trim() && (env.GITHUB_REPOSITORY?.trim() || env.FIZOT_ALERT_GITHUB_REPO?.trim()));
  return webhook || github;
}

export function assertAlertChannelsForProduction(env: NodeJS.ProcessEnv = process.env): void {
  const isProd = env.NODE_ENV === "production" || env.FIZOT_ENV === "production";
  if (!isProd) return;
  if (!alertChannelsConfigured(env)) {
    throw new Error(
      "production Admin requires an alert channel: set FIZOT_ALERT_WEBHOOK_URL (and FIZOT_ALERT_WEBHOOK_SECRET) and/or GITHUB_TOKEN + GITHUB_REPOSITORY",
    );
  }
}

export function signAlertBody(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyAlertSignature(input: {
  secret: string;
  timestamp: string;
  body: string;
  signature: string;
}): boolean {
  const expected = signAlertBody(input.secret, input.timestamp, input.body);
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(input.signature.replace(/^sha256=/i, ""), "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Legal-safe alert payload: hash + steps + kind only. */
export function buildDeletionAlertPayload(input: {
  workspaceIdHash: string;
  kind: "12h" | "24h" | "hourly";
  message: string;
  receipt: DeletionReceipt;
}): Record<string, unknown> {
  return {
    type: "deletion_overdue",
    kind: input.kind,
    workspaceIdHash: input.workspaceIdHash,
    stepsDone: input.receipt.stepsDone,
    status: input.receipt.status,
    requestedAt: input.receipt.requestedAt,
    message: input.message,
  };
}

export async function openOrUpdateGithubIssue(input: {
  token: string;
  repository: string;
  title: string;
  body: string;
  fetchImpl?: typeof fetch;
}): Promise<{ number: number; created: boolean }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const [owner, repo] = input.repository.split("/");
  if (!owner || !repo) throw new Error("invalid_github_repository");
  const listUrl = `https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${owner}/${repo} is:issue is:open in:title "${input.title}"`)}`;
  const listed = await fetchImpl(listUrl, {
    headers: {
      authorization: `Bearer ${input.token}`,
      accept: "application/vnd.github+json",
      "user-agent": "fizot-admin-deletion-alert",
    },
  });
  const listedJson = await listed.json().catch(() => ({})) as { items?: Array<{ number: number; title: string }> };
  const existing = (listedJson.items ?? []).find((i) => i.title === input.title);
  if (existing) {
    const comment = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/issues/${existing.number}/comments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "fizot-admin-deletion-alert",
        },
        body: JSON.stringify({ body: input.body }),
      },
    );
    if (!comment.ok) {
      throw new Error(`github_comment_failed:${comment.status}`);
    }
    return { number: existing.number, created: false };
  }
  const created = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "fizot-admin-deletion-alert",
    },
    body: JSON.stringify({ title: input.title, body: input.body }),
  });
  const createdJson = await created.json().catch(() => ({})) as { number?: number };
  if (!created.ok || typeof createdJson.number !== "number") {
    throw new Error(`github_issue_failed:${created.status}`);
  }
  return { number: createdJson.number, created: true };
}

export function createDeletionAlert(config: AlertChannelConfig = {}): DeletionAlert {
  const env = process.env;
  const webhookUrl = (config.webhookUrl ?? env.FIZOT_ALERT_WEBHOOK_URL)?.trim() || null;
  const webhookSecret = (config.webhookSecret ?? env.FIZOT_ALERT_WEBHOOK_SECRET)?.trim() || null;
  const githubToken = (config.githubToken ?? env.GITHUB_TOKEN)?.trim() || null;
  const githubRepository = (config.githubRepository ?? env.FIZOT_ALERT_GITHUB_REPO ?? env.GITHUB_REPOSITORY)?.trim() || null;
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;

  return async (input) => {
    const payload = buildDeletionAlertPayload(input);
    const body = JSON.stringify(payload);

    if (webhookUrl) {
      const timestamp = String(Math.floor(now() / 1000));
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-fizot-timestamp": timestamp,
      };
      if (webhookSecret) {
        headers["x-fizot-signature"] = signAlertBody(webhookSecret, timestamp, body);
      }
      const res = await fetchImpl(webhookUrl, { method: "POST", headers, body });
      if (!res.ok) throw new Error(`alert_webhook_failed:${res.status}`);
    }

    if (githubToken && githubRepository) {
      const title = "Deletion overdue";
      const issueBody = [
        "Fizot Admin deletion job overdue / failed.",
        "",
        `- kind: \`${input.kind}\``,
        `- workspaceIdHash: \`${input.workspaceIdHash}\``,
        `- status: \`${input.receipt.status}\``,
        `- stepsDone: \`${input.receipt.stepsDone.join(",") || "(none)"}\``,
        `- requestedAt: \`${input.receipt.requestedAt}\``,
        "",
        input.message,
      ].join("\n");
      await openOrUpdateGithubIssue({
        token: githubToken,
        repository: githubRepository,
        title,
        body: issueBody,
        fetchImpl,
      });
    }
  };
}

export function resolveDeletionAlert(options: {
  alert?: DeletionAlert;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): DeletionAlert | undefined {
  if (options.alert) return options.alert;
  const env = options.env ?? process.env;
  if (!alertChannelsConfigured(env)) return undefined;
  return createDeletionAlert({
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
}
