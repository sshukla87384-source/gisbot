import type { User } from "@gis/database";
import type { Context, SessionFlavor } from "grammy";

export interface SessionData {
  /** What the next free-text message means (Bot UX doc: conversations). */
  awaiting?:
    | "search"
    | "ticket"
    | "ticket_reply"
    | "otp_secret"
    | "admin_ticket_reply"
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
    | "admin_margin_floor"
    | "admin_qual_threshold"
    | "admin_recov_minutes"
    | "admin_variant_cost"
    | "admin_totp_code"
    | "admin_totp_confirm"
    | "admin_totp_disable"
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
    | "review_comment"
    | "keys_search"
    | "admin_rev_reply"
    | "admin_tst_search"
    | "admin_tst_name"
    | "admin_tst_body"
    | "admin_tst_rating"
    | "admin_tst_product"
    | "admin_tst_source"
    | "admin_tst_order"
    | "admin_tst_editbody"
    | "admin_tst_import"
    | "replace_reason"
    | "replace_proof"
    | "admin_reject_note"
    | "admin_p_reuse"
    | "admin_p_reuseqty"
    | "admin_p_manqty"
    | "admin_p_warrantydays"
    | "wallet_inr_amount"
    | "wallet_inr_utr"
    | "admin_bnpl_user"
    | "admin_sup_docs"
    | "admin_fup_text"
    | "admin_fup_delay"
    | "admin_fup_btn"
    | "admin_loy_tiers"
    | "admin_gift_user"
    | "admin_gift_title"
    | "admin_gift_detail"
    | "admin_spn_targets"
    | "admin_spn_days"
    | "admin_spn_min"
    | "admin_spn_max"
    | "admin_spn_day"
    | "admin_autop_hours"
    | "admin_fx_rate"
    | "admin_fx_surcharge"
    | "admin_tool_adjust"
    | "admin_tool_key"
    | "admin_tool_risk"
    | "admin_tr_key"
    | "admin_tr_url"
    | null;
  /** Last search query, so pagination callbacks stay under 64 bytes. */
  lastSearch?: string;
  /** Admin-panel working context for multi-step flows. */
  admOrderId?: string;
  admProductId?: string;
  admVariantId?: string;
  /** Bulk supplier-product picker state. */
  supSelected?: string[];
  supPage?: number;
  supFilter?: "all" | "visible" | "hidden";
  /** Supplier being configured from its docs. */
  supTarget?: string;
  /** Failed payment-verify attempts, so the paste state cannot stick forever. */
  payRetries?: number;
  /** INR wallet top-up being requested (minor units). */
  inrTopupMinor?: number;
  /** Pending price-change announcement offered to the admin. */
  priceAlert?: { productId: string; oldMinor: number; newMinor: number; currency: string };
  /** Auto-translate provider being configured. */
  trProvider?: string;
  trKey?: string;
  /** Admin review-list filter. */
  revFilter?: "pending" | "approved" | "rejected" | "all";
  revTarget?: string;
  tstFilter?: "DRAFT" | "PENDING" | "PUBLISHED" | "ARCHIVED" | "ALL";
  tstSearch?: string;
  tstTarget?: string;
  toolPct?: number;
  promoProduct?: string;
  promoStyle?: string;
  giftUser?: string;
  giftTitle?: string;
  tstDraft?: { customerName?: string; body?: string; rating?: number; productName?: string | null };
  /** Review awaiting an optional written comment. */
  reviewId?: string;
  /** Order item the customer is raising a replacement claim on. */
  replaceItemId?: string;
  /** Reason text captured before the screenshot step. */
  replaceReason?: string;
  /** Order whose units the customer is picking from. */
  replaceOrderId?: string;
  /** Units ticked in the replacement picker (order item ids). */
  replaceSelected?: string[];
  /** Page of the unit picker. */
  replacePage?: number;
  /** The set submitted for a batch claim. */
  replaceBatch?: string[];
  /**
   * A pasted TOTP secret for the OTP tool. Session-only and wiped by 🗑 Clear —
   * deliberately never written to the database, a log, or a URL.
   */
  otpSecret?: string;
  otpReveal?: boolean;
  /** True when the replacement form is raising a support ticket instead of a claim. */
  replaceViaTicket?: boolean;
  /** Ticket the customer is replying to, or the admin is answering. */
  ticketId?: string;
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
