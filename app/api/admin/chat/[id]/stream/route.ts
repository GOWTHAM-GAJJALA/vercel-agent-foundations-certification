import type { NextRequest } from "next/server";
import { isAdminRequest, jsonError, resumeChatRun } from "@/lib/chat-route";

/** Resume an admin chat run's stream (admin session required). */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAdminRequest(request)) return jsonError(401, "Sign in to use the admin agent.");
  const { id } = await params;
  return resumeChatRun(request, id, "adminChatWorkflow");
}
