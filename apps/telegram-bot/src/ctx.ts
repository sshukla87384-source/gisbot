import type { User } from "@gis/database";
import type { Context, SessionFlavor } from "grammy";

export interface SessionData {
  /** What the next free-text message means (Bot UX doc: conversations). */
  awaiting?:
    | "search"
    | "ticket"
    | "devtopup"
    | "admin_passcode"
    | "admin_broadcast"
    | "admin_txnid"
    | "admin_flashsale"
    | "admin_addkeys"
    | null;
  /** Last search query, so pagination callbacks stay under 64 bytes. */
  lastSearch?: string;
  /** Admin-panel working context for multi-step flows. */
  admOrderId?: string;
  admProductId?: string;
  admVariantId?: string;
}

export type BotUser = User & { roleNames: string[] };

export type Ctx = Context &
  SessionFlavor<SessionData> & {
    /** Resolved DB user — attached by middleware for private chats. */
    user: BotUser;
  };
