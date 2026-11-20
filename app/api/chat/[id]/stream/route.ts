import type { NextRequest } from "next/server";
import { resumeChatRun } from "@/lib/chat-route";

/**
 * Resume a shopping chat run's stream after a dropped connection or a page
 * refresh. `id` is the workflow run id; `?startIndex=` is how many UI chunks
 * the client already received.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return resumeChatRun(request, id, "shoppingChatWorkflow");
}
