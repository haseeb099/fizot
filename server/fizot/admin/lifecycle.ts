/**
 * Workspace provisioning lifecycle (P4.2 / FZ-25).
 * requested → creating → ready → sleeping|awake → deleting → deleted | failed
 */
export const WORKSPACE_STATES = [
  "requested",
  "creating",
  "ready",
  "awake",
  "sleeping",
  "deleting",
  "deleted",
  "failed",
] as const;

export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

export type StateTransition = {
  workspaceId: string;
  fromState: WorkspaceState | null;
  toState: WorkspaceState;
  at: string;
  reason: string;
};

const ALLOWED: Record<WorkspaceState, readonly WorkspaceState[]> = {
  requested: ["creating", "failed", "deleting"],
  creating: ["ready", "failed", "deleting"],
  ready: ["awake", "sleeping", "deleting", "failed"],
  awake: ["sleeping", "ready", "deleting", "failed"],
  sleeping: ["awake", "ready", "deleting", "failed"],
  deleting: ["deleted", "failed"],
  deleted: [],
  failed: ["creating", "deleting", "ready"],
};

export function isWorkspaceState(value: unknown): value is WorkspaceState {
  return typeof value === "string" && (WORKSPACE_STATES as readonly string[]).includes(value);
}

export function mayTransition(from: WorkspaceState | null, to: WorkspaceState): boolean {
  if (from === null) return to === "requested" || to === "creating";
  if (from === to) return true;
  return (ALLOWED[from] ?? []).includes(to);
}

export function assertTransition(from: WorkspaceState | null, to: WorkspaceState, reason: string): void {
  if (!mayTransition(from, to)) {
    throw Object.assign(new Error(`illegal_transition:${from ?? "null"}->${to}:${reason}`), {
      status: 409,
      code: "illegal_transition",
    });
  }
}
