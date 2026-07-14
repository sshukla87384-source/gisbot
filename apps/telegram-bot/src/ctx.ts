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
    | "binance_txnid"
    | "admin_p_name"
    | "admin_p_desc"
    | "admin_p_priceinr"
    | "admin_p_priceusd"
    | "admin_newcat"
    | "admin_api_name"
    | null;
  /** Last search query, so pagination callbacks stay under 64 bytes. */
  lastSearch?: string;
  /** Admin-panel working context for multi-step flows. */
  admOrderId?: string;
  admProductId?: string;
  admVariantId?: string;
  /** Customer Binance order awaiting a transaction ID. */
  binanceOrderId?: string;
  /** In-progress product being created via the admin wizard. */
  admDraft?: {
    name?: string;
    description?: string;
    type?: string;
    categoryId?: string;
    priceInrMinor?: number;
  };
  /** Name for an API key being created via the bot admin. */
  admApiName?: string;
}

export type BotUser = User & { roleNames: string[] };

export type Ctx = Context &
  SessionFlavor<SessionData> & {
    /** Resolved DB user — attached by middleware for private chats. */
    user: BotUser;
  };
