import { createWebhook, FatalError, sleep } from "workflow";
import {
  ApiRequestError,
  createReturn,
  getReturn,
  notifyReturnInProcess,
  preauthorizeRefund,
} from "@/lib/api";
import type { RefundPreauthorization, Return } from "@/lib/types";

export type ReturnRequest = {
  orderId: string;
  reason: string;
  items: { productId: string; quantity: number }[];
};

type Decision = {
  source: "callback" | "poll" | "pending";
  decision: string | null;
  refundAmount: number | null;
  notes: string | null;
};

// How long to wait for the store's callback before checking status directly.
// The store decides 15-60s after filing.
const DECISION_WAIT = "3m";

/**
 * Durable return process, started by the shopping agent's returnOrder tool.
 *
 * Each side effect is its own step. Steps that already succeeded are never
 * re-run: if filing the return fails and is retried, the customer isn't
 * notified twice and the refund isn't pre-authorized twice (the store's
 * pre-authorize endpoint creates a new authorization on every call).
 */
export async function returnOrderWorkflow(request: ReturnRequest) {
  "use workflow";

  await notifyCustomerStep(request.orderId);
  const authorization = await preauthorizeRefundStep(request.orderId);

  // The store POSTs its decision to this URL when processing finishes.
  using webhook = createWebhook();
  const filed = await fileReturnStep(request, webhook.url);

  const outcome = await Promise.race([
    webhook.then(async (incoming) => ({
      kind: "callback" as const,
      payload: (await incoming.json()) as {
        decision?: string;
        refundAmount?: number;
        notes?: string;
      },
    })),
    sleep(DECISION_WAIT).then(() => ({ kind: "timeout" as const })),
  ]);

  const decision: Decision =
    outcome.kind === "callback"
      ? {
          source: "callback",
          decision: outcome.payload.decision ?? null,
          refundAmount: outcome.payload.refundAmount ?? null,
          notes: outcome.payload.notes ?? null,
        }
      : await pollReturnStep(filed.id);

  await recordDecisionStep(request.orderId, filed.id, decision);

  return {
    orderId: request.orderId,
    returnId: filed.id,
    refundAuthorizationId: authorization.id,
    ...decision,
  };
}

async function notifyCustomerStep(orderId: string): Promise<void> {
  "use step";
  await notifyReturnInProcess(orderId);
}

async function preauthorizeRefundStep(
  orderId: string,
): Promise<RefundPreauthorization> {
  "use step";
  try {
    return await preauthorizeRefund(orderId);
  } catch (error) {
    throw toStepError(error, "pre-authorizing the refund");
  }
}

async function fileReturnStep(
  request: ReturnRequest,
  callback: string,
): Promise<Return> {
  "use step";
  try {
    return await createReturn({ ...request, callback });
  } catch (error) {
    throw toStepError(error, "filing the return");
  }
}

async function pollReturnStep(returnId: string): Promise<Decision> {
  "use step";
  try {
    const current = await getReturn(returnId);
    return {
      source: current.decision ? "poll" : "pending",
      decision: current.decision,
      refundAmount: current.refundAmount,
      notes: current.notes,
    };
  } catch (error) {
    throw toStepError(error, "checking the return status");
  }
}

async function recordDecisionStep(
  orderId: string,
  returnId: string,
  decision: Decision,
): Promise<void> {
  "use step";
  // In production this would email the customer the decision.
  console.log(
    `[returnOrder] return ${returnId} for order ${orderId}: ${decision.decision ?? "still pending"} (via ${decision.source})`,
  );
}

/** 4xx responses won't succeed on retry: fail permanently. Others retry. */
function toStepError(error: unknown, action: string): Error {
  if (
    error instanceof ApiRequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  ) {
    return new FatalError(`${action} failed: ${error.message}`);
  }
  const status = error instanceof ApiRequestError ? error.status : "unknown";
  return new Error(`${action} failed (status ${status}); retrying.`);
}
