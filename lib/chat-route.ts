import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import type { NextRequest } from "next/server";
import { getRun, start } from "workflow/api";
import { ADMIN_COOKIE_NAME, ADMIN_PASSWORD } from "@/lib/admin-auth";

/** Conversation turns sent to the model per request (keeps prompts bounded). */
const MAX_MESSAGES = 40;

export function isAdminRequest(request: NextRequest): boolean {
  return request.cookies.get(ADMIN_COOKIE_NAME)?.value === ADMIN_PASSWORD;
}

export function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/**
 * Reads and validates `{ messages }` from a chat request. Only user and
 * assistant messages are accepted; the history is capped to the latest turns.
 */
export async function readMessages(
  request: Request,
): Promise<UIMessage[] | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Request body must be JSON.");
  }
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonError(400, "Expected a non-empty `messages` array.");
  }
  const valid = messages.every(
    (m) =>
      m &&
      typeof m === "object" &&
      (m.role === "user" || m.role === "assistant") &&
      Array.isArray(m.parts),
  );
  if (!valid) {
    return jsonError(400, "Each message needs a user/assistant role and parts.");
  }
  if (messages[messages.length - 1].role !== "user") {
    return jsonError(400, "The last message must come from the user.");
  }
  return (messages as UIMessage[]).slice(-MAX_MESSAGES);
}

/**
 * Starts a chat workflow run and streams it back as UI message chunks. The
 * run id header lets WorkflowChatTransport reconnect to the same run.
 */
export async function startChatRun<TMessage extends UIMessage>(
  workflow: (messages: TMessage[]) => Promise<unknown>,
  messages: TMessage[],
): Promise<Response> {
  const run = await start(workflow, [messages]);
  return createUIMessageStreamResponse({
    stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()),
    headers: { "x-workflow-run-id": run.runId },
  });
}

/**
 * Re-attaches to an existing run's durable stream. `startIndex` counts UI
 * chunks the client already has; the raw stream is replayed from the start
 * and exactly that many converted chunks are skipped, so a resumed response
 * never duplicates or drops output and the run itself is never restarted.
 */
export async function resumeChatRun(
  request: NextRequest,
  runId: string,
  expectedWorkflow: string,
): Promise<Response> {
  if (!/^wrun_[A-Za-z0-9]+$/.test(runId)) {
    return jsonError(400, "Invalid run id.");
  }
  const raw = Number(request.nextUrl.searchParams.get("startIndex") ?? "0");
  const uiStartIndex = Number.isSafeInteger(raw) && raw > 0 ? raw : 0;

  let workflowName: string;
  const run = getRun(runId);
  try {
    workflowName = await run.workflowName;
  } catch {
    return jsonError(404, "No such chat run.");
  }
  // Only stream runs of this endpoint's own workflow.
  if (!workflowName.endsWith(`//${expectedWorkflow}`)) {
    return jsonError(404, "No such chat run.");
  }

  const readable = run
    .getReadable({ startIndex: 0 })
    .pipeThrough(createModelCallToUIChunkTransform({ uiStartIndex }));

  return createUIMessageStreamResponse({
    stream: readable,
    headers: { "x-workflow-run-id": runId },
  });
}
