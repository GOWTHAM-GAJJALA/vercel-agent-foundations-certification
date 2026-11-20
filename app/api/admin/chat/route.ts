import type { NextRequest } from "next/server";
import {
  isAdminRequest,
  jsonError,
  readMessages,
  startChatRun,
} from "@/lib/chat-route";
import {
  adminChatWorkflow,
  type AdminUIMessage,
} from "@/lib/workflows/admin-chat-flow";

/**
 * Employee chat. Requires the admin session cookie (the `/admin` page guard
 * in proxy.ts doesn't cover API routes). Each message starts a durable
 * `adminChatWorkflow` run.
 */
export async function POST(request: NextRequest) {
  if (!isAdminRequest(request)) return jsonError(401, "Sign in to use the admin agent.");
  const messages = await readMessages(request);
  if (messages instanceof Response) return messages;
  return startChatRun(adminChatWorkflow, messages as AdminUIMessage[]);
}
