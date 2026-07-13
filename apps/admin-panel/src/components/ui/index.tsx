"use client";
import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";
const variants: Record<Variant, string> = {
  primary: "bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-50",
  secondary: "bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:opacity-50",
  danger: "bg-red-600 text-white hover:bg-red-500 disabled:opacity-50",
  ghost: "text-slate-600 hover:bg-slate-100 disabled:opacity-50",
};

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={cn("inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition", variants[variant], className)}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn("w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500", className)}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn("w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500", className)}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn("w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500", className)}
      {...props}
    >
      {children}
    </select>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border border-slate-200 bg-white p-4 shadow-sm", className)}>{children}</div>;
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="mb-1 block text-xs font-medium text-slate-500">{children}</label>;
}

const badgeTone: Record<string, string> = {
  green: "bg-emerald-100 text-emerald-700",
  yellow: "bg-amber-100 text-amber-700",
  red: "bg-red-100 text-red-700",
  blue: "bg-sky-100 text-sky-700",
  gray: "bg-slate-100 text-slate-600",
};

export function Badge({ tone = "gray", children }: { tone?: keyof typeof badgeTone; children: ReactNode }) {
  return <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", badgeTone[tone])}>{children}</span>;
}

/** Map a domain status string to a badge tone. */
export function statusTone(status: string): keyof typeof badgeTone {
  const s = status.toUpperCase();
  if (["COMPLETED", "ACTIVE", "PAID", "PROCESSED", "APPROVED", "VERIFIED", "CREDITED", "RESOLVED"].includes(s)) return "green";
  if (["PENDING_PAYMENT", "PENDING_FULFILLMENT", "PENDING", "PENDING_HOLD", "AWAITING_STOCK", "OPEN", "IN_PROGRESS", "DRAFT", "PAUSED", "RESERVED", "WAITING_CUSTOMER"].includes(s)) return "yellow";
  if (["CANCELLED", "EXPIRED", "REFUNDED", "FAILED", "BANNED", "SUSPENDED", "REJECTED", "DISABLED", "MANUAL_REVIEW", "WITHHELD", "ARCHIVED"].includes(s)) return "red";
  return "gray";
}
