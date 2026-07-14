"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3, Boxes, ClipboardList, FileClock, LayoutDashboard, LogOut, Package,
  Settings, Ticket, Users, Wallet, BadgePercent, Megaphone,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { authStore } from "@/lib/auth-store";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/orders", label: "Orders", icon: ClipboardList },
  { href: "/manual-queue", label: "Manual Queue", icon: FileClock },
  { href: "/categories", label: "Categories", icon: Boxes },
  { href: "/products", label: "Products", icon: Package },
  { href: "/inventory", label: "Inventory", icon: Boxes },
  { href: "/users", label: "Users", icon: Users },
  { href: "/withdrawals", label: "Withdrawals", icon: Wallet },
  { href: "/coupons", label: "Coupons", icon: BadgePercent },
  { href: "/tickets", label: "Tickets", icon: Ticket },
  { href: "/broadcasts", label: "Broadcasts", icon: Megaphone },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/audit", label: "Audit Logs", icon: BarChart3 },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    authStore.setToken(null);
    router.push("/login");
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-slate-900 text-slate-300">
      <div className="px-5 py-5 text-lg font-semibold text-white">Get It Sasta</div>
      <nav className="flex-1 space-y-1 px-3">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
                active ? "bg-slate-700 text-white" : "hover:bg-slate-800",
              )}
            >
              <Icon size={16} />
              {label}
            </Link>
          );
        })}
      </nav>
      <button onClick={logout} className="m-3 flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-slate-800">
        <LogOut size={16} /> Sign out
      </button>
    </aside>
  );
}
