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
    | "admin_p_image"
    | "admin_p_edit_name"
    | "admin_p_edit_desc"
    | "admin_p_edit_emoji"
    | "admin_p_edit_highlight"
    | "admin_p_price_inr"
    | "admin_p_price_usd"
    | "admin_wallet_user"
    | "admin_wallet_amount"
    | "admin_bnpl_user"
    | "admin_bnpl_limit"
    | "admin_api_name"
    | "wallet_topup_amount"
    | "wallet_topup_txn"
    | "api_key_name"
    | "coupon_code"
    | "upi_ref"
    | null;
  /** Last search query, so pagination callbacks stay under 64 bytes. */
  lastSearch?: string;
  /** Admin-panel working context for multi-step flows. */
  admOrderId?: string;
  admProductId?: string;
  admVariantId?: string;
  /** INR price captured in step 1 of the two-step variant price editor. */
  admPriceInrMinor?: number;
  /** Target user for the admin wallet-adjust flow. */
  admWalletUserId?: string;
  /** Target user for the admin BNPL-limit flow. */
  admBnplUserId?: string;
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
  /** Pending customer wallet top-up awaiting a transaction ID. */
  walletTopupId?: string;
  /** Pending UPI order awaiting a UTR reference. */
  upiOrderId?: string;
  /** Coupon code the customer applied at checkout (validated at pay time). */
  couponCode?: string;
}

export type BotUser = User & { roleNames: string[] };

export type Ctx = Context &
  SessionFlavor<SessionData> & {
    /** Resolved DB user — attached by middleware for private chats. */
    user: BotUser;
  };
