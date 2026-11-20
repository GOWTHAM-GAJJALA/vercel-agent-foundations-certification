import { readMessages, startChatRun } from "@/lib/chat-route";
import {
  shoppingChatWorkflow,
  type ShoppingUIMessage,
} from "@/lib/workflows/chat-flow";

/**
 * Customer chat. Each message starts a durable `shoppingChatWorkflow` run;
 * the response streams the agent's output and carries the run id so the
 * client can reconnect via `/api/chat/[id]/stream`.
 */
export async function POST(request: Request) {
  const messages = await readMessages(request);
  if (messages instanceof Response) return messages;
  return startChatRun(shoppingChatWorkflow, messages as ShoppingUIMessage[]);
}
