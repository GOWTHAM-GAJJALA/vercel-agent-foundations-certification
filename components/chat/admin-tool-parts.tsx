"use client";

/**
 * Tool activity for the admin agent: back-office lookups as compact,
 * expandable summaries; sandbox commands as a terminal with running,
 * success, and failure states; memory writes as a confirmation.
 */
import {
  AlertCircle,
  BookmarkCheck,
  Boxes,
  ChartColumn,
  LifeBuoy,
  RotateCcw,
  Search,
  Tags,
  Terminal,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

// Approval states can't occur (no admin tool needs approval); anything that
// isn't a final output is shown as in progress.
type ToolState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

const TOOL_META: Record<string, { label: string; running: string; icon: ReactNode }> = {
  getSupportTickets: { label: "Support tickets", running: "Reading support tickets…", icon: <LifeBuoy className="size-3.5" /> },
  getReturnsHistory: { label: "Returns history", running: "Reading returns history…", icon: <RotateCcw className="size-3.5" /> },
  getInventoryStock: { label: "Inventory", running: "Reading inventory…", icon: <Boxes className="size-3.5" /> },
  getSalesAnalytics: { label: "Sales analytics", running: "Reading sales data…", icon: <ChartColumn className="size-3.5" /> },
  searchProducts: { label: "Catalog search", running: "Searching the catalog…", icon: <Search className="size-3.5" /> },
  getAllCategories: { label: "Categories", running: "Loading categories…", icon: <Tags className="size-3.5" /> },
};

function describeFilters(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  return Object.entries(input)
    .filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
    .join(" · ");
}

function rangeLabel(range?: { from?: string; to?: string }): string | null {
  if (!range?.from || !range?.to) return null;
  return `${range.from.slice(0, 10)} → ${range.to.slice(0, 10)}`;
}

function summaryFor(tool: string, output: Record<string, unknown>): string {
  switch (tool) {
    case "getSupportTickets":
      return `${output.count} ticket${output.count === 1 ? "" : "s"}`;
    case "getReturnsHistory":
      return `${output.count} return${output.count === 1 ? "" : "s"}`;
    case "getInventoryStock": {
      const p = output.pagination as { totalItems?: number } | undefined;
      return `${output.count} stock record${output.count === 1 ? "" : "s"}${p?.totalItems !== undefined ? ` of ${p.totalItems}` : ""}`;
    }
    case "getSalesAnalytics": {
      const t = output.totals as { revenue?: string; unitsSold?: number } | undefined;
      return `${output.productCount} products · ${t?.unitsSold ?? 0} units · ${t?.revenue ?? "$0.00"}`;
    }
    case "searchProducts":
      return `${output.count} product${output.count === 1 ? "" : "s"}`;
    case "getAllCategories":
      return `${(output.categories as unknown[] | undefined)?.length ?? 0} categories`;
    default:
      return "Done";
  }
}

export function DataToolPart({
  tool,
  state,
  input,
  output,
}: {
  tool: string;
  state: ToolState;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  errorText?: string;
}) {
  const meta = TOOL_META[tool] ?? { label: tool, running: "Working…", icon: null };
  const filters = describeFilters(input);

  if (state !== "output-available" && state !== "output-error") {
    return (
      <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        <span>{meta.running}</span>
        {filters ? <span className="truncate opacity-70">({filters})</span> : null}
      </div>
    );
  }

  const failed = state === "output-error" || (output && output.ok === false);
  if (failed) {
    const message =
      state === "output-error"
        ? "The store service didn't respond after several retries."
        : String(output?.error ?? "Unknown error");
    return (
      <div role="alert" className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
        <div>
          <p className="font-medium text-foreground">{meta.label} lookup failed</p>
          <p className="text-muted-foreground">{message}</p>
        </div>
      </div>
    );
  }

  const range = rangeLabel(output?.range as { from?: string; to?: string } | undefined);
  return (
    <details className="group rounded-md border border-border bg-muted/30 text-xs open:bg-muted/50">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="text-muted-foreground" aria-hidden="true">{meta.icon}</span>
        <span className="font-medium text-foreground">{meta.label}</span>
        <span className="text-muted-foreground">{output ? summaryFor(tool, output) : ""}</span>
        {range ? <span className="ml-auto hidden text-muted-foreground sm:inline">{range}</span> : null}
      </summary>
      <div className="space-y-1 border-t border-border px-3 py-2 text-muted-foreground">
        {range ? <p>Date range: {range}</p> : null}
        {filters ? <p>Filters: {filters}</p> : null}
        {typeof output?.savedTo === "string" ? (
          <p>
            Saved in sandbox: <code className="rounded bg-background px-1 py-0.5">{output.savedTo}</code>
          </p>
        ) : null}
        {typeof output?.note === "string" ? <p>{output.note}</p> : null}
      </div>
    </details>
  );
}

export type BashOutput = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
};

export function BashPart({
  state,
  command,
  output,
}: {
  state: ToolState;
  command?: string;
  output?: BashOutput;
}) {
  const running = state !== "output-available" && state !== "output-error";
  const infraError = state === "output-error";
  const failed = infraError || (output ? output.exitCode !== 0 : false);

  return (
    <figure
      className={cn(
        "overflow-hidden rounded-md border bg-zinc-950 text-[11px] text-zinc-100",
        failed ? "border-destructive/60" : "border-zinc-800",
      )}
    >
      <figcaption className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-zinc-400">
        <Terminal className="size-3.5" aria-hidden="true" />
        <span>Sandbox</span>
        <span className="ml-auto" role="status" aria-live="polite">
          {running ? (
            <span className="inline-flex items-center gap-1.5">
              <Spinner className="size-3" /> Running…
            </span>
          ) : infraError ? (
            <Badge variant="destructive" className="text-[10px]">Sandbox unavailable</Badge>
          ) : output ? (
            <Badge
              variant={output.exitCode === 0 ? "secondary" : "destructive"}
              className="text-[10px]"
            >
              {output.exitCode === 0 ? "Done" : `Exit ${output.exitCode}`} · {(output.durationMs / 1000).toFixed(1)}s
            </Badge>
          ) : null}
        </span>
      </figcaption>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-emerald-300">
        <span className="select-none text-zinc-500">$ </span>
        {command ?? output?.command ?? ""}
      </pre>
      {output && (output.stdout || output.stderr) ? (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all border-t border-zinc-800 px-3 py-2 font-mono">
          {output.stdout}
          {output.stderr ? <span className="text-red-300">{output.stderr}</span> : null}
        </pre>
      ) : null}
      {infraError ? (
        <p className="border-t border-zinc-800 px-3 py-2 text-red-300">
          The command couldn&apos;t run: the sandbox didn&apos;t respond after several retries.
        </p>
      ) : null}
    </figure>
  );
}

export function MemoryPart({
  state,
  note,
}: {
  state: ToolState;
  note?: string;
}) {
  if (state !== "output-available" && state !== "output-error") {
    return (
      <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" /> Saving to memory…
      </div>
    );
  }
  if (state === "output-error") {
    return (
      <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
        <AlertCircle className="size-3.5" aria-hidden="true" /> Couldn&apos;t save to memory.
      </div>
    );
  }
  return (
    <div role="status" className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
      <BookmarkCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
      <span>
        <span className="font-medium text-foreground">Saved to memory: </span>
        <span className="text-muted-foreground">{note}</span>
      </span>
    </div>
  );
}
