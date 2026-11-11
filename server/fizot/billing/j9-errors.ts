/**
 * Typed Stripe errors for J9. Cleanup may only ignore verified already-gone
 * states; message substrings are never used as success criteria.
 */
export class J9StripeError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly stripeType: string | null;

  constructor(input: { status: number; code?: string | null; stripeType?: string | null; message: string }) {
    super(input.message);
    this.name = "J9StripeError";
    this.status = input.status;
    this.code = input.code ?? null;
    this.stripeType = input.stripeType ?? null;
  }
}

export type CleanupResource = "checkout_session" | "subscription" | "customer" | "test_clock";

export type CleanupErrorClass =
  | {
    action: "tolerate";
    reason:
      | "resource_missing"
      | "session_already_closed"
      | "subscription_already_canceled"
      | "customer_already_deleted"
      | "test_clock_already_deleted";
  }
  | { action: "fail"; reason: string };

/** Parse a Stripe error JSON body into typed fields. Never treats free text as success. */
export function stripeErrorFromHttp(status: number, bodyText: string): J9StripeError {
  let code: string | null = null;
  let stripeType: string | null = null;
  let message = bodyText.slice(0, 180);
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: unknown; type?: unknown; message?: unknown } };
    const err = parsed.error;
    if (err && typeof err === "object") {
      if (typeof err.code === "string" && err.code) code = err.code;
      if (typeof err.type === "string" && err.type) stripeType = err.type;
      if (typeof err.message === "string" && err.message) message = err.message.slice(0, 180);
    }
  } catch {
    // Non-JSON bodies stay as status-only typed failures.
  }
  return new J9StripeError({ status, code, stripeType, message: `stripe_${status}:${message}` });
}

/**
 * Only documented already-absent / already-closed states are harmless.
 * HTTP 500/429/network and unknown codes always fail.
 */
export function classifyCleanupError(resource: CleanupResource, error: unknown): CleanupErrorClass {
  if (!(error instanceof J9StripeError)) {
    return { action: "fail", reason: "untyped_or_network_error" };
  }
  if (error.status === 429 || error.status >= 500) {
    return { action: "fail", reason: `http_${error.status}` };
  }
  if (resource === "checkout_session") {
    if (
      error.code === "checkout_session_already_expired"
      || error.code === "checkout_session_unexpected_state"
    ) {
      return { action: "tolerate", reason: "session_already_closed" };
    }
  }
  if (resource === "subscription" && error.code === "resource_already_deleted") {
    return { action: "tolerate", reason: "subscription_already_canceled" };
  }
  if (resource === "customer" && error.code === "resource_already_deleted") {
    return { action: "tolerate", reason: "customer_already_deleted" };
  }
  if (resource === "test_clock" && (error.code === "resource_already_deleted" || error.code === "resource_missing")) {
    return { action: "tolerate", reason: "test_clock_already_deleted" };
  }
  if (error.status === 404 || error.code === "resource_missing") {
    return { action: "tolerate", reason: "resource_missing" };
  }
  return {
    action: "fail",
    reason: error.code ? `code_${error.code}` : `http_${error.status}`,
  };
}
