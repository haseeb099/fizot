export type CapState = {
  instanceId: string;
  limit: number;
  used: number;
  alerted: boolean;
};

export type CapDecision =
  | { ok: true; alert: boolean; used: number; limit: number }
  | { ok: false; status: 402; body: { error: { code: string; type: string; message: string } }; used: number; limit: number };

export class CapBook {
  private readonly caps = new Map<string, CapState>();

  setLimit(instanceId: string, limit: number): void {
    const current = this.caps.get(instanceId);
    this.caps.set(instanceId, { instanceId, limit, used: current?.used ?? 0, alerted: current?.alerted ?? false });
  }

  /** Check whether `extra` tokens may be spent. Alert at 80%, hard stop at 100%. */
  decide(instanceId: string, extra: number, used: number): CapDecision {
    const state = this.caps.get(instanceId) ?? { instanceId, limit: Number.POSITIVE_INFINITY, used: 0, alerted: false };
    const limit = state.limit;
    const next = used + extra;
    if (next > limit) {
      return {
        ok: false,
        status: 402,
        used,
        limit,
        body: {
          error: {
            code: "instance_cap_exhausted",
            type: "insufficient_quota",
            message: "This instance has used its Fizot credit cap.",
          },
        },
      };
    }
    const alert = limit > 0 && next / limit >= 0.8;
    if (alert) state.alerted = true;
    this.caps.set(instanceId, { ...state, used: next, alerted: state.alerted || alert });
    return { ok: true, alert, used: next, limit };
  }

  state(instanceId: string): CapState | undefined {
    return this.caps.get(instanceId);
  }
}
