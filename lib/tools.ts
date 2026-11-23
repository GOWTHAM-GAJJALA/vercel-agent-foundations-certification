/**
 * Tools for both agents.
 *
 * Every tool's work runs in a `"use step"` function, so when an agent runs
 * inside a workflow each tool call is a durable, retried step:
 *
 * - Transient failures (network errors, 5xx, 429) are THROWN so the Workflow
 *   runtime retries the step.
 * - Expected problems (validation, missing records, ineligible orders) are
 *   RETURNED as `{ ok: false, error }` so the agent can explain them instead
 *   of inventing a successful outcome.
 *
 * Error messages are built from status/code/path only. The store client puts
 * BYPASS_SECRET in request URLs, so raw error details never reach the model.
 *
 * Shopping and admin tool sets are exported separately; the admin-only
 * capabilities (back-office data, sandbox bash, memory) are never given to
 * the shopping agent.
 */
import { tool } from "ai";
import { start } from "workflow/api";
import { HookConflictError } from "workflow/errors";
import { z } from "zod";
import {
  ApiRequestError,
  getBackOfficeReturns,
  getBackOfficeSales,
  getBackOfficeStock,
  getBackOfficeSupportTickets,
  getCategories,
  getOrder,
  getProductById,
  getProductStock,
  getProducts,
} from "@/lib/api";
import { formatPrice } from "@/lib/format";
import { appendMemory, runBash, writeDataFile } from "@/lib/sandbox";
import type { Category, Product } from "@/lib/types";
import { returnOrderWorkflow } from "@/lib/workflows/return-flow";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export type ToolFailure = {
  ok: false;
  error: string;
  code?: string;
  notFound?: boolean;
};

/**
 * Turns a store API error into either a retry (throw) or a failure result
 * the agent can explain. Never includes request URLs or error details.
 */
function handleApiError(error: unknown, action: string): ToolFailure {
  if (error instanceof ApiRequestError) {
    const transient =
      error.status === 0 || error.status === 429 || error.status >= 500;
    if (transient) {
      throw new Error(
        `The store service is temporarily unavailable while ${action} (status ${error.status || "network"}).`,
      );
    }
    return {
      ok: false,
      error: error.message,
      code: error.code,
      notFound: error.status === 404,
    };
  }
  throw new Error(`Unexpected error while ${action}.`);
}

export type ProductSummary = {
  id: string;
  name: string;
  slug: string;
  category: string;
  price: number;
  currency: string;
  priceFormatted: string;
  image: string | null;
  url: string;
  featured: boolean;
};

function summarize(product: Product): ProductSummary {
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    category: product.category,
    price: product.price,
    currency: product.currency,
    priceFormatted: formatPrice(product.price, product.currency),
    image: product.images[0] ?? null,
    url: `/products/${product.id}`,
    featured: product.featured,
  };
}

function matchCategory(input: string, categories: Category[]): Category | undefined {
  const needle = input.trim().toLowerCase();
  return categories.find(
    (c) => c.slug.toLowerCase() === needle || c.name.toLowerCase() === needle,
  );
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, "Use YYYY-MM-DD or an ISO 8601 datetime")
  .optional();

// ---------------------------------------------------------------------------
// Catalog steps (shared by both agents)
// ---------------------------------------------------------------------------

export type CategoriesResult =
  | { ok: true; categories: Category[] }
  | ToolFailure;

export async function getAllCategoriesStep(): Promise<CategoriesResult> {
  "use step";
  try {
    return { ok: true, categories: await getCategories() };
  } catch (error) {
    return handleApiError(error, "loading categories");
  }
}

export type SearchProductsInput = {
  query?: string;
  category?: string;
  page?: number;
  limit?: number;
};

export type SearchProductsResult =
  | {
      ok: true;
      query: string | null;
      category: string | null;
      page: number;
      count: number;
      hasMore: boolean;
      products: ProductSummary[];
    }
  | (ToolFailure & { validCategories?: string[] });

export async function searchProductsStep(
  input: SearchProductsInput,
): Promise<SearchProductsResult> {
  "use step";
  const limit = input.limit ?? 12;
  const page = input.page ?? 1;
  const query = input.query?.trim() || undefined;
  let categorySlug: string | undefined;

  try {
    if (input.category?.trim()) {
      const categories = await getCategories();
      const match = matchCategory(input.category, categories);
      if (!match) {
        return {
          ok: false,
          error: `"${input.category}" is not a store category.`,
          code: "INVALID_CATEGORY",
          validCategories: categories.map((c) => c.slug),
        };
      }
      categorySlug = match.slug;
    }

    const products = await getProducts({
      search: query,
      category: categorySlug,
      page,
      limit,
    });
    return {
      ok: true,
      query: query ?? null,
      category: categorySlug ?? null,
      page,
      count: products.length,
      hasMore: products.length === limit,
      products: products.map(summarize),
    };
  } catch (error) {
    return handleApiError(error, "searching products");
  }
}

export type ProductDetailsResult =
  | {
      ok: true;
      product: ProductSummary & {
        description: string;
        images: string[];
        tags: string[];
        stock: { stock: number; inStock: boolean; lowStock: boolean } | null;
      };
    }
  | ToolFailure;

export async function getProductDetailsStep(input: {
  productId: string;
}): Promise<ProductDetailsResult> {
  "use step";
  try {
    const product = await getProductById(input.productId.trim());
    // Stock is a separate, uncached endpoint; details still render without it.
    const stock = await getProductStock(product.id).catch(() => null);
    return {
      ok: true,
      product: {
        ...summarize(product),
        description: product.description,
        images: product.images,
        tags: product.tags,
        stock: stock
          ? { stock: stock.stock, inStock: stock.inStock, lowStock: stock.lowStock }
          : null,
      },
    };
  } catch (error) {
    const failure = handleApiError(error, "loading product details");
    if (failure.notFound) {
      failure.error = `No product found for "${input.productId}". Try searching by name instead.`;
    }
    return failure;
  }
}

// ---------------------------------------------------------------------------
// Returns (shopping agent)
// ---------------------------------------------------------------------------

const NON_RETURNABLE: Record<string, string> = {
  pending: "it hasn't been paid for yet",
  paid: "it is still being prepared and hasn't shipped yet",
  cancelled: "it was cancelled",
};

export type ReturnOrderResult =
  | {
      ok: true;
      status: "filed";
      orderId: string;
      reference: string;
      reason: string;
      items: { productId: string; name: string; quantity: number }[];
      refundAmountFormatted: string;
    }
  | ToolFailure;

/**
 * Validates the order, then starts the durable return workflow and returns
 * right away so the chat isn't blocked. The workflow notifies the customer,
 * pre-authorizes the refund, and files the return, each as its own step.
 */
export async function startReturnStep(input: {
  orderId: string;
  reason: string;
}): Promise<ReturnOrderResult> {
  "use step";
  const orderId = input.orderId.trim().replace(/^#/, "");
  try {
    const order = await getOrder(orderId);
    const blocked = NON_RETURNABLE[order.status];
    if (blocked) {
      return {
        ok: false,
        error: `Order ${orderId} can't be returned because ${blocked}.`,
        code: "NOT_RETURNABLE",
      };
    }

    const items = order.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
    }));
    // The store accepts duplicate returns, so the Workflow start itself is
    // made idempotent per order: a second request within 24 hours finds the
    // token taken (HookConflictError) and no second run is created.
    let run;
    try {
      run = await start(
        returnOrderWorkflow,
        [{ orderId, reason: input.reason.trim(), items }],
        { experimental_hook: { token: `return:${orderId}`, experimental_minRetention: "24h" } },
      );
    } catch (error) {
      if (HookConflictError.is(error)) {
        return {
          ok: false,
          error: `A return for order ${orderId} was already filed recently, so a second one wasn't created. The existing return is being processed.`,
          code: "ALREADY_FILED",
        };
      }
      throw error;
    }

    const hydrated = order.items as Array<
      (typeof order.items)[number] & { product?: { name?: string } }
    >;
    return {
      ok: true,
      status: "filed",
      orderId,
      reference: run.runId,
      reason: input.reason.trim(),
      items: hydrated.map((item) => ({
        productId: item.productId,
        name: item.product?.name ?? item.productId,
        quantity: item.quantity,
      })),
      refundAmountFormatted: formatPrice(order.total, order.currency),
    };
  } catch (error) {
    const failure = handleApiError(error, "looking up the order");
    if (failure.notFound) {
      failure.error = `We couldn't find an order with number ${orderId}. Please check the number.`;
    }
    return failure;
  }
}

// ---------------------------------------------------------------------------
// Back-office steps (admin agent only)
// ---------------------------------------------------------------------------

function fileTag(parts: Array<string | number | boolean | undefined>): string {
  return parts
    .filter((p) => p !== undefined && p !== "")
    .map((p) => String(p).replace(/[^a-zA-Z0-9-]+/g, "-").slice(0, 40))
    .join("_");
}

/** Product id -> name for the whole catalog (28 products; 100 per page). */
async function productNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let page = 1; page <= 5; page++) {
    const products = await getProducts({ page, limit: 100 });
    for (const p of products) names.set(p.id, p.name);
    if (products.length < 100) break;
  }
  return names;
}

function money(cents: number | null | undefined, currency = "USD"): string | null {
  return typeof cents === "number" ? formatPrice(cents, currency) : null;
}

export type SupportTicketsInput = {
  from?: string;
  to?: string;
  status?: "open" | "pending" | "resolved" | "closed";
  priority?: "low" | "normal" | "high" | "urgent";
  category?:
    | "shipping"
    | "returns"
    | "product_quality"
    | "sizing"
    | "billing"
    | "payment"
    | "account"
    | "other";
  assignee?: string;
  limit?: number;
};

export async function getSupportTicketsStep(input: SupportTicketsInput) {
  "use step";
  try {
    const { data, meta } = await getBackOfficeSupportTickets({
      ...input,
      limit: input.limit ?? 100,
    });
    const savedTo = await writeDataFile(
      fileTag(["support-tickets", meta.from.slice(0, 10), meta.to.slice(0, 10), input.status, input.priority, input.category, input.assignee]),
      { meta, filters: input, tickets: data },
    );
    return {
      ok: true as const,
      range: { from: meta.from, to: meta.to },
      count: meta.count,
      limitApplied: input.limit ?? 100,
      savedTo,
      tickets: data.slice(0, 30).map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        category: t.category,
        assignee: t.assignee,
        relatedOrderId: t.relatedOrderId,
        createdAt: t.createdAt,
      })),
      note:
        data.length > 30
          ? `Showing 30 of ${data.length}; the full list is in ${savedTo}.`
          : undefined,
    };
  } catch (error) {
    return handleApiError(error, "loading support tickets");
  }
}

export type ReturnsHistoryInput = {
  from?: string;
  to?: string;
  status?: "pending" | "processing" | "completed";
  decision?: "approved" | "rejected" | "needs_info";
  limit?: number;
};

export async function getReturnsHistoryStep(input: ReturnsHistoryInput) {
  "use step";
  try {
    const [{ data: raw, meta }, names] = await Promise.all([
      getBackOfficeReturns({ ...input, limit: input.limit ?? 200 }),
      productNames(),
    ]);
    // Return items only carry product ids; add names so the agent doesn't
    // need a catalog lookup per product.
    const data = raw.map((r) => ({
      ...r,
      items: r.items.map((it) => ({ ...it, name: names.get(it.productId) ?? null })),
    }));
    const savedTo = await writeDataFile(
      fileTag(["returns", meta.from.slice(0, 10), meta.to.slice(0, 10), input.status, input.decision]),
      { meta, filters: input, returns: data },
    );
    return {
      ok: true as const,
      range: { from: meta.from, to: meta.to },
      count: meta.count,
      limitApplied: input.limit ?? 200,
      savedTo,
      returns: data.slice(0, 25).map((r) => ({
        id: r.id,
        orderId: r.orderId,
        items: r.items,
        reason: r.reason,
        status: r.status,
        decision: r.decision,
        refundAmount: money(r.refundAmount),
        orderTotal: money(r.order?.total),
        createdAt: r.createdAt,
      })),
      note:
        data.length > 25
          ? `Showing 25 of ${data.length}; the full list (with items, orders, and refunds) is in ${savedTo}.`
          : undefined,
    };
  } catch (error) {
    return handleApiError(error, "loading returns history");
  }
}

export type InventoryInput = {
  productIds?: string[];
  lowStock?: boolean;
  inStock?: boolean;
  page?: number;
  limit?: number;
  allPages?: boolean;
};

export async function getInventoryStockStep(input: InventoryInput) {
  "use step";
  try {
    const limit = input.limit ?? 100;
    let page = input.page ?? 1;
    const first = await getBackOfficeStock({ ...input, page, limit });
    const entries = [...first.data];
    let pagination = first.meta.pagination;
    while (input.allPages && pagination.hasNextPage && page < 20) {
      page += 1;
      const next = await getBackOfficeStock({ ...input, page, limit });
      entries.push(...next.data);
      pagination = next.meta.pagination;
    }
    const savedTo = await writeDataFile(
      fileTag(["inventory", input.lowStock !== undefined ? `low-${input.lowStock}` : undefined, input.inStock !== undefined ? `in-${input.inStock}` : undefined, input.allPages ? "all" : `p${input.page ?? 1}`]),
      { pagination, filters: input, stock: entries },
    );
    return {
      ok: true as const,
      count: entries.length,
      pagination: {
        page: input.allPages ? `1-${page}` : pagination.page,
        totalItems: pagination.total,
        totalPages: pagination.totalPages,
        hasNextPage: input.allPages ? false : pagination.hasNextPage,
      },
      savedTo,
      stock: entries.slice(0, 40).map((s) => ({
        productId: s.productId,
        name: s.product.name,
        category: s.product.category,
        stock: s.stock,
        inStock: s.inStock,
        lowStock: s.lowStock,
      })),
      note:
        entries.length > 40
          ? `Showing 40 of ${entries.length}; the full list is in ${savedTo}.`
          : undefined,
    };
  } catch (error) {
    return handleApiError(error, "loading inventory");
  }
}

export type SalesInput = { from?: string; to?: string; productId?: string };

export async function getSalesAnalyticsStep(input: SalesInput) {
  "use step";
  try {
    const { data, meta } = await getBackOfficeSales(input);
    const savedTo = await writeDataFile(
      fileTag(["sales", meta.from.slice(0, 10), meta.to.slice(0, 10), input.productId]),
      { meta, filters: input, rows: data },
    );
    const sorted = [...data].sort((a, b) => b.revenue - a.revenue);
    return {
      ok: true as const,
      range: { from: meta.from, to: meta.to, days: meta.days },
      totals: {
        unitsSold: meta.totals.unitsSold,
        ordersCount: meta.totals.ordersCount,
        revenue: money(meta.totals.revenue, meta.currency),
      },
      productCount: data.length,
      savedTo,
      topByRevenue: sorted.slice(0, 15).map((r) => ({
        productId: r.productId,
        name: r.product.name,
        category: r.product.category,
        unitsSold: r.unitsSold,
        ordersCount: r.ordersCount,
        revenue: money(r.revenue, r.currency),
      })),
      note:
        data.length > 15
          ? `Showing the top 15 of ${data.length} products by revenue; all rows (revenue in cents) are in ${savedTo}.`
          : undefined,
    };
  } catch (error) {
    const failure = handleApiError(error, "loading sales analytics");
    if (failure.notFound && input.productId) {
      failure.error = `No product with id "${input.productId}". Use searchProducts to find the right id.`;
    }
    return failure;
  }
}

export async function bashStep(input: { command: string }) {
  "use step";
  // A non-zero exit code is a normal result (the agent sees stderr and can
  // fix its command); only sandbox infrastructure errors throw and retry.
  return runBash(input.command);
}

export async function saveMemoryStep(input: { note: string }) {
  "use step";
  const memory = await appendMemory(input.note);
  return {
    ok: true as const,
    saved: input.note.trim(),
    totalEntries: memory.split("\n").filter((l) => l.startsWith("- ")).length,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const searchProducts = tool({
  description:
    "Search or browse the product catalog. Omit `query` and `category` to browse the full catalog. `category` must be a category slug or name from getAllCategories.",
  inputSchema: z.object({
    query: z.string().max(100).optional().describe("Free-text search over names, descriptions, and tags"),
    category: z.string().max(50).optional().describe("Category slug or name, e.g. 'hoodies'"),
    page: z.number().int().min(1).max(50).optional(),
    limit: z.number().int().min(1).max(24).optional().describe("Results per page, default 12"),
  }),
  execute: async (input) => searchProductsStep(input),
});

const getAllCategories = tool({
  description: "List the store's current product categories with product counts.",
  inputSchema: z.object({}),
  execute: async () => getAllCategoriesStep(),
});

const getProductDetails = tool({
  description:
    "Get full details for one product: description, price, all images, tags, and live stock.",
  inputSchema: z.object({
    productId: z.string().min(1).max(100).describe("The product id (or slug) from search results"),
  }),
  execute: async (input) => getProductDetailsStep(input),
});

const returnOrder = tool({
  description:
    "Request a return for a customer's order. Looks up the order, then starts the return process (customer notification, refund pre-authorization, filing the return). Call once per order.",
  inputSchema: z.object({
    orderId: z.string().min(1).max(20).regex(/^#?[A-Za-z0-9-]+$/, "Order numbers contain only letters and digits").describe("The order number, e.g. 11111"),
    reason: z.string().min(3).max(500).describe("Why the customer is returning the order"),
  }),
  execute: async (input) => startReturnStep(input),
});

export const shoppingTools = {
  searchProducts,
  getAllCategories,
  getProductDetails,
  returnOrder,
};

const getSupportTickets = tool({
  description:
    "Read support tickets, filtered by date range, status, priority, category, and assignee. Defaults to the last 30 days. Saves the full result to a JSON file in the sandbox.",
  inputSchema: z.object({
    from: isoDate.describe("Start date, YYYY-MM-DD"),
    to: isoDate.describe("End date, YYYY-MM-DD"),
    status: z.enum(["open", "pending", "resolved", "closed"]).optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    category: z
      .enum(["shipping", "returns", "product_quality", "sizing", "billing", "payment", "account", "other"])
      .optional(),
    assignee: z.string().max(50).optional().describe("Staff username, e.g. 'alex'"),
    limit: z.number().int().min(1).max(500).optional().describe("Max tickets, default 100"),
  }),
  execute: async (input) => getSupportTicketsStep(input),
});

const getReturnsHistory = tool({
  description:
    "Read historical returns (with items, associated order, and refund amounts), filtered by date range, status, and decision. Defaults to the last 30 days. Saves the full result to a JSON file in the sandbox.",
  inputSchema: z.object({
    from: isoDate,
    to: isoDate,
    status: z.enum(["pending", "processing", "completed"]).optional(),
    decision: z.enum(["approved", "rejected", "needs_info"]).optional(),
    limit: z.number().int().min(1).max(500).optional().describe("Max returns, default 200"),
  }),
  execute: async (input) => getReturnsHistoryStep(input),
});

const getInventoryStock = tool({
  description:
    "Read inventory stock levels. Filter by product ids, low stock (1-5 units), or availability. Paginated; set allPages to fetch every page. Saves the full result to a JSON file in the sandbox.",
  inputSchema: z.object({
    productIds: z.array(z.string().max(100)).max(100).optional(),
    lowStock: z.boolean().optional(),
    inStock: z.boolean().optional(),
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional().describe("Per page, default 100"),
    allPages: z.boolean().optional().describe("Fetch all pages (for complete joins)"),
  }),
  execute: async (input) => getInventoryStockStep(input),
});

const getSalesAnalytics = tool({
  description:
    "Read sales and revenue per product for a date range (default: last 30 days), optionally for one product. Revenue in the saved file is in integer cents. Saves the full result to a JSON file in the sandbox.",
  inputSchema: z.object({
    from: isoDate,
    to: isoDate,
    productId: z.string().max(100).optional(),
  }),
  execute: async (input) => getSalesAnalyticsStep(input),
});

const bash = tool({
  description:
    "Run a bash command in the admin's isolated Vercel Sandbox (cwd /vercel/sandbox). Data files from back-office tools are in /vercel/sandbox/data. jq, python3, and node are available. Use it for all arithmetic, aggregation, and joins.",
  inputSchema: z.object({
    command: z.string().min(1).max(4000),
  }),
  execute: async (input) => bashStep(input),
});

const saveMemory = tool({
  description:
    "Save a short note to persistent memory for future conversations: employee preferences, corrections, or business context. Not for raw store data.",
  inputSchema: z.object({
    note: z.string().min(3).max(500),
  }),
  execute: async (input) => saveMemoryStep(input),
});

export const adminTools = {
  getSupportTickets,
  getReturnsHistory,
  getInventoryStock,
  getSalesAnalytics,
  searchProducts,
  getAllCategories,
  bash,
  saveMemory,
};
