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
    | "admin_p_editname"
    | "admin_p_editdesc"
    | "admin_p_guide"
    | "admin_p_btntext"
    | "admin_api_name"
    | "admin_wallet_adj"
    | "admin_price_user"
    | "admin_price_amount"
    | "admin_pin"
    | "admin_pubprice_usd"
    | "admin_pubprice_inr"
    | "admin_manual_key"
    | "admin_btn_label"
    | "admin_newpass"
    | "admin_ref_first"
    | "admin_ref_repeat"
    | "admin_bnpl"
    | "admin_emoji_capture"
    | "admin_emoji_name"
    | "wallet_topup_amount"
    | "wallet_topup_txn"
    | "wallet_free_txn"
    | "api_key_name"
    | "upi_ref"
    | "buy_qty"
    | "coupon_code"
    | "support_chat"
    | "admin_dm_reply"
    | "admin_web_email"
    | "admin_web_pass"
    | "admin_delivery_note"
    | "admin_binance_key"
    | "admin_binance_secret"
    | "admin_sup_name"
    | "admin_sup_url"
    | "admin_sup_key"
    | "admin_sup_markup"
    | "admin_user_lookup"
    | "admin_user_addbal"
    | "admin_user_deductbal"
    | "admin_prod_search"
    | "admin_flash_headline"
    | "sale_title"
    | "sale_body"
    | "sale_btntext"
    | "sale_timer"
    | "sale_url"
    | "replace_reason"
    | "replace_proof"
    | "admin_reject_note"
    | "admin_p_warrantydays"
    | "admin_tr_key"
    | "admin_tr_url"
    | null;
  /** Last search query, so pagination callbacks stay under 64 bytes. */
  lastSearch?: string;
  /** Admin-panel working context for multi-step flows. */
  admOrderId?: string;
  admProductId?: string;
  admVariantId?: string;
  /** Pending price-change announcement offered to the admin. */
  priceAlert?: { productId: string; oldMinor: number; newMinor: number; currency: string };
  /** Auto-translate provider being configured. */
  trProvider?: string;
  trKey?: string;
  /** Order item the customer is raising a replacement claim on. */
  replaceItemId?: string;
  /** Reason text captured before the screenshot step. */
  replaceReason?: string;
  /** Replacement request the admin is rejecting (awaiting a note). */
  admReplaceId?: string;
  /** Customer Binance order awaiting a transaction ID. */
  binanceOrderId?: string;
  /** In-progress product being created via the admin wizard. */
  admDraft?: {
    name?: string;
    nameHtml?: string;
    description?: string;
    descriptionHtml?: string;
    type?: string;
    categoryId?: string;
    priceInrMinor?: number;
  };
  /** Name for an API key being created via the bot admin. */
  admApiName?: string;
  /** Custom-pricing wizard state. */
  priceProductId?: string;
  priceUserId?: string;
  priceUserLabel?: string;
  priceAmountMinor?: number;
  pubUsdMinor?: number;
  admManualItemId?: string;
  bcBody?: string;
  bcBtnText?: string;
  bcBtnUrl?: string;
  saleDraft?: { title?: string; body?: string; btnText?: string; btnStyle?: string; btnUrl?: string; endsHours?: number };
  btnKey?: string;
  pendEmojiId?: string;
  pendEmojiGlyph?: string;
  dmTarget?: string;
  webAdminEmail?: string;
  binanceKeyTmp?: string;
  supDraft?: { name?: string; url?: string; key?: string };
  userTarget?: string;
  prodSearch?: string;
  /** Pending customer wallet top-up awaiting a transaction ID. */
  walletTopupId?: string;
  /** Pending UPI order awaiting a UTR reference. */
  upiOrderId?: string;
  /** Variant the user is buying; awaiting quantity. */
  buyVariantId?: string;
  buyProductId?: string;
  buyMaxQty?: number;
  /** True on the update where the user was just created. */
  isNewUser?: boolean;
}

export type BotUser = User & { roleNames: string[] };

export type Ctx = Context &
  SessionFlavor<SessionData> & {
    /** Resolved DB user — attached by middleware for private chats. */
    user: BotUser;
  };
