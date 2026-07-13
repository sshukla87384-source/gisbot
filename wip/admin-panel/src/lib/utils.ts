import { useEffect, useState } from "react";

/** Minimal className combiner. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return "Something went wrong. Please try again.";
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/** "3h 12m ago" style relative time; also returns raw hours for SLA colors. */
export function timeAgo(value: string | null | undefined): { label: string; hours: number } {
  if (!value) return { label: "—", hours: 0 };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { label: "—", hours: 0 };
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.max(0, Math.floor(diffMs / 60_000));
  const hours = minutes / 60;
  if (minutes < 1) return { label: "just now", hours };
  if (minutes < 60) return { label: `${minutes}m ago`, hours };
  if (hours < 24) return { label: `${Math.floor(hours)}h ${minutes % 60}m ago`, hours };
  const days = Math.floor(hours / 24);
  return { label: `${days}d ${Math.floor(hours % 24)}h ago`, hours };
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Debounce a changing value (used for search inputs). */
export function useDebounced<T>(value: T, delayMs = 400): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Pretty-print an unknown value as JSON for read-only display. */
export function prettyJson(value: unknown): string {
  if (value === undefined || value === null) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
