"use client";

/**
 * Generative UI for the shopping agent's tool results: product results,
 * product details, return confirmations, and the loading / failure states
 * for every tool. Shoppers see store content, never raw tool data.
 */
import Image from "next/image";
import Link from "next/link";
import { AlertCircle, CheckCircle2, PackageX, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import type {
  ProductDetailsResult,
  ReturnOrderResult,
  SearchProductsResult,
} from "@/lib/tools";

export function ToolLoading({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
    >
      <Spinner className="size-3.5" />
      <span>{label}</span>
    </div>
  );
}

export function ToolNotice({
  title,
  message,
  tone = "error",
}: {
  title: string;
  message: string;
  tone?: "error" | "empty";
}) {
  const Icon = tone === "empty" ? PackageX : AlertCircle;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className="flex gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
    >
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div>
        <p className="font-medium text-foreground">{title}</p>
        <p className="text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

export function ProductResults({ result }: { result: SearchProductsResult }) {
  if (!result.ok) {
    const hint =
      "validCategories" in result && result.validCategories?.length
        ? ` Available categories: ${result.validCategories.join(", ")}.`
        : "";
    return <ToolNotice title="Search didn't work" message={`${result.error}${hint}`} />;
  }
  if (result.products.length === 0) {
    return (
      <ToolNotice
        tone="empty"
        title="No matching products"
        message={
          result.query
            ? `Nothing matched "${result.query}"${result.category ? ` in ${result.category}` : ""}.`
            : "This category has no products right now."
        }
      />
    );
  }
  const label = [
    result.query ? `"${result.query}"` : null,
    result.category ? `in ${result.category}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <section aria-label={`Products${label ? ` ${label}` : ""}`} className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {result.count} product{result.count === 1 ? "" : "s"}
        {label ? ` ${label}` : ""}
        {result.hasMore ? " · more available" : ""}
      </p>
      <ul className="grid grid-cols-2 gap-2">
        {result.products.map((product) => (
          <li key={product.id}>
            <Link
              href={product.url}
              className="group block overflow-hidden rounded-md border border-border bg-card transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="relative aspect-square bg-secondary">
                {product.image ? (
                  <Image
                    src={product.image}
                    alt={product.name}
                    fill
                    sizes="(min-width: 768px) 200px, 140px"
                    className="object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                ) : null}
              </div>
              <div className="space-y-0.5 p-2">
                <p className="line-clamp-2 text-xs font-medium leading-snug text-foreground">
                  {product.name}
                </p>
                <p className="text-xs text-muted-foreground">{product.priceFormatted}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ProductDetailsCard({ result }: { result: ProductDetailsResult }) {
  if (!result.ok) {
    return (
      <ToolNotice
        tone={result.notFound ? "empty" : "error"}
        title={result.notFound ? "Product not found" : "Couldn't load this product"}
        message={result.error}
      />
    );
  }
  const { product } = result;
  const stock = product.stock;
  const stockLabel = !stock
    ? "Stock unavailable right now"
    : !stock.inStock
      ? "Out of stock"
      : stock.lowStock
        ? `Only ${stock.stock} left`
        : `In stock · ${stock.stock}`;
  return (
    <article
      aria-label={product.name}
      className="overflow-hidden rounded-md border border-border bg-card"
    >
      <div className="flex gap-1 overflow-x-auto bg-secondary">
        {product.images.map((src, i) => (
          <div key={src} className="relative aspect-square w-full min-w-full">
            <Image
              src={src}
              alt={i === 0 ? product.name : `${product.name}, image ${i + 1}`}
              fill
              sizes="(min-width: 768px) 420px, 280px"
              className="object-cover"
            />
          </div>
        ))}
      </div>
      <div className="space-y-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold leading-snug text-foreground">{product.name}</h3>
          <p className="shrink-0 text-sm font-semibold text-foreground">{product.priceFormatted}</p>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{product.description}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge
            variant={stock && !stock.inStock ? "destructive" : "secondary"}
            className="text-[11px]"
          >
            {stockLabel}
          </Badge>
          <Badge variant="outline" className="text-[11px] capitalize">
            {product.category}
          </Badge>
          {product.tags.slice(0, 4).map((tag) => (
            <Badge key={tag} variant="outline" className="text-[11px] text-muted-foreground">
              {tag}
            </Badge>
          ))}
        </div>
        <Link
          href={product.url}
          className="inline-flex text-xs font-medium text-foreground underline underline-offset-4 hover:no-underline"
        >
          View product page
        </Link>
      </div>
    </article>
  );
}

export function ReturnConfirmation({ result }: { result: ReturnOrderResult }) {
  if (!result.ok) {
    return (
      <ToolNotice
        tone={result.notFound ? "empty" : "error"}
        title={result.notFound ? "Order not found" : "Return not filed"}
        message={result.error}
      />
    );
  }
  return (
    <div
      role="status"
      className="space-y-2 rounded-md border border-border bg-card p-3 text-xs"
    >
      <p className="flex items-center gap-1.5 font-semibold text-foreground">
        <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" />
        Return filed for order {result.orderId}
      </p>
      <ul className="space-y-0.5 text-muted-foreground">
        {result.items.map((item) => (
          <li key={item.productId}>
            {item.quantity} × {item.name}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        <RotateCcw className="mr-1 inline size-3" aria-hidden="true" />
        We&apos;ll email you, pre-authorize a refund of up to {result.refundAmountFormatted}, and let you know the review decision. Reason: “{result.reason}”.
      </p>
    </div>
  );
}
