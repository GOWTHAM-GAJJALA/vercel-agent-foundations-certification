import { WorkflowAgent, type ModelCallStreamPart } from "@ai-sdk/workflow";
import {
  convertToModelMessages,
  isStepCount,
  type InferUITools,
  type UIDataTypes,
  type UIMessage,
} from "ai";
import { getWritable } from "workflow";
import { adminInstructions, MODEL, MODEL_SETTINGS } from "@/lib/agent";
import { readMemory } from "@/lib/sandbox";
import { adminTools } from "@/lib/tools";

/** Chat message type that knows every admin tool's input and output. */
export type AdminUIMessage = UIMessage<
  unknown,
  UIDataTypes,
  InferUITools<typeof adminTools>
>;

/**
 * Reads the memory file from the admin sandbox. Runs in application code at
 * the start of every admin conversation turn, before the agent starts.
 */
async function loadMemoryStep(): Promise<{ memory: string; available: boolean }> {
  "use step";
  try {
    return { memory: await readMemory(), available: true };
  } catch (error) {
    console.error("[admin] could not read memory:", error instanceof Error ? error.message : error);
    return { memory: "", available: false };
  }
}

/**
 * One admin turn as a durable workflow run: memory is loaded first, then the
 * agent's model calls and tools (back-office reads, sandbox bash, memory
 * writes) each run as retried workflow steps.
 */
export async function adminChatWorkflow(messages: AdminUIMessage[]) {
  "use workflow";

  const { memory, available } = await loadMemoryStep();
  const instructions = available
    ? adminInstructions(memory)
    : `${adminInstructions("")}\n\nNote: the memory file could not be read for this conversation (sandbox unavailable). Tell the user if they ask about saved context.`;

  const agent = new WorkflowAgent({
    model: MODEL,
    ...MODEL_SETTINGS,
    instructions,
    tools: adminTools,
  });

  const result = await agent.stream({
    messages: await convertToModelMessages(messages),
    writable: getWritable<ModelCallStreamPart>(),
    stopWhen: isStepCount(16),
  });

  return { steps: result.steps.length };
}
