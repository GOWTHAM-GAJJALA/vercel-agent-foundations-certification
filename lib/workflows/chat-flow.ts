import { WorkflowAgent, type ModelCallStreamPart } from "@ai-sdk/workflow";
import {
  convertToModelMessages,
  isStepCount,
  type InferUITools,
  type UIDataTypes,
  type UIMessage,
} from "ai";
import { getWritable } from "workflow";
import { MODEL, shoppingInstructions } from "@/lib/agent";
import { shoppingTools } from "@/lib/tools";

/** Chat message type that knows every shopping tool's input and output. */
export type ShoppingUIMessage = UIMessage<
  unknown,
  UIDataTypes,
  InferUITools<typeof shoppingTools>
>;

/**
 * One shopping turn as a durable workflow run.
 *
 * WorkflowAgent runs each model call and each tool execution as a workflow
 * step: transient failures are retried, finished steps are never repeated,
 * and the output is written to the run's durable stream so a client can
 * reconnect (`/api/chat/[id]/stream`) after a refresh without restarting it.
 */
export async function shoppingChatWorkflow(messages: ShoppingUIMessage[]) {
  "use workflow";

  const agent = new WorkflowAgent({
    model: MODEL,
    instructions: shoppingInstructions(),
    tools: shoppingTools,
  });

  const result = await agent.stream({
    messages: await convertToModelMessages(messages),
    writable: getWritable<ModelCallStreamPart>(),
    stopWhen: isStepCount(8),
  });

  return { steps: result.steps.length };
}
