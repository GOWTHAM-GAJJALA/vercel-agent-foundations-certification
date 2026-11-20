"use client";

/**
 * Admin chat at /admin, connected to the store admin agent
 * (`/api/admin/chat` -> `adminChatWorkflow`). Separate conversation,
 * separate storage key, and admin-only tools.
 */
import { Bot } from "lucide-react";
import {
  BashPart,
  DataToolPart,
  MemoryPart,
} from "@/components/chat/admin-tool-parts";
import { DurableChat } from "@/components/chat/durable-chat";
import type { AdminUIMessage } from "@/lib/workflows/admin-chat-flow";

const SUGGESTIONS = [
  "Show me low-stock items",
  "What were yesterday's top sellers?",
  "Summarize this week's revenue",
  "Which products have the highest return rates?",
  "Which low-stock items are top sellers?",
];

type Part = AdminUIMessage["parts"][number];

function renderAdminPart(part: Part) {
  switch (part.type) {
    case "tool-bash":
      return (
        <BashPart
          state={part.state}
          command={part.input?.command}
          output={part.state === "output-available" ? part.output : undefined}
        />
      );
    case "tool-saveMemory":
      return <MemoryPart state={part.state} note={part.input?.note} />;
    case "tool-getSupportTickets":
    case "tool-getReturnsHistory":
    case "tool-getInventoryStock":
    case "tool-getSalesAnalytics":
    case "tool-searchProducts":
    case "tool-getAllCategories":
      return (
        <DataToolPart
          tool={part.type.slice("tool-".length)}
          state={part.state}
          input={part.input as Record<string, unknown> | undefined}
          output={
            part.state === "output-available"
              ? (part.output as unknown as Record<string, unknown>)
              : undefined
          }
          errorText={part.state === "output-error" ? part.errorText : undefined}
        />
      );
    default:
      return null;
  }
}

export function AdminAgentChat() {
  return (
    <DurableChat<AdminUIMessage>
      storageKey="ship-it-shop:admin-chat"
      api="/api/admin/chat"
      placeholder="Ask the admin agent…"
      emptyTitle="Store operations assistant"
      emptyDescription="Ask about support tickets, returns, inventory, or sales. Calculations run in an isolated sandbox."
      emptyIcon={<Bot className="size-6" aria-hidden="true" />}
      suggestions={SUGGESTIONS}
      renderPart={(part) => renderAdminPart(part)}
      thinkingLabel="Investigating…"
    />
  );
}
