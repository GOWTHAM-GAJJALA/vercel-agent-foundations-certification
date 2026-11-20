"use client";

/**
 * Storefront chat panel, connected to the shopping agent
 * (`/api/chat` -> `shoppingChatWorkflow`). Tool results render as product
 * cards, product details, and return confirmations.
 */
import { ShoppingBag } from "lucide-react";
import { DurableChat } from "@/components/chat/durable-chat";
import {
  ProductDetailsCard,
  ProductResults,
  ReturnConfirmation,
  ToolLoading,
  ToolNotice,
} from "@/components/chat/shopping-tool-parts";
import type { ShoppingUIMessage } from "@/lib/workflows/chat-flow";

type Part = ShoppingUIMessage["parts"][number];

function renderShoppingPart(part: Part) {
  switch (part.type) {
    case "tool-searchProducts": {
      if (part.state === "output-available") return <ProductResults result={part.output} />;
      if (part.state === "output-error")
        return <ToolNotice title="Search failed" message="The product search didn't respond. Please try again." />;
      const q = part.input?.query;
      const c = part.input?.category;
      return (
        <ToolLoading
          label={`Searching products${q ? ` for "${q}"` : ""}${c ? ` in ${c}` : ""}…`}
        />
      );
    }
    case "tool-getProductDetails": {
      if (part.state === "output-available") return <ProductDetailsCard result={part.output} />;
      if (part.state === "output-error")
        return <ToolNotice title="Couldn't load product" message="The product lookup didn't respond. Please try again." />;
      return <ToolLoading label="Loading product details…" />;
    }
    case "tool-getAllCategories": {
      if (part.state === "output-available") {
        return part.output.ok ? null : (
          <ToolNotice title="Couldn't load categories" message={part.output.error} />
        );
      }
      if (part.state === "output-error")
        return <ToolNotice title="Couldn't load categories" message="Please try again." />;
      return <ToolLoading label="Checking categories…" />;
    }
    case "tool-returnOrder": {
      if (part.state === "output-available") return <ReturnConfirmation result={part.output} />;
      if (part.state === "output-error")
        return <ToolNotice title="Return not filed" message="We couldn't start your return. Nothing was filed; please try again." />;
      return (
        <ToolLoading
          label={`Looking up order${part.input?.orderId ? ` ${part.input.orderId}` : ""}…`}
        />
      );
    }
    default:
      return null;
  }
}

export function AgentChat() {
  return (
    <DurableChat<ShoppingUIMessage>
      storageKey="ship-it-shop:shopping-chat"
      api="/api/chat"
      placeholder="Ask about products or a return…"
      emptyTitle="Hi! How can I help?"
      emptyDescription="Find products, compare items, or start a return."
      emptyIcon={<ShoppingBag className="size-6" aria-hidden="true" />}
      suggestions={[
        "What categories do you have?",
        "Show me hoodies",
        "I want to return order 11111",
      ]}
      renderPart={(part) => renderShoppingPart(part)}
      thinkingLabel="Finding that for you…"
    />
  );
}
