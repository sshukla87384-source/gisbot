/** Minimal i18n for the customer-facing bot. Falls back to English. */
export type Locale = "en" | "hi" | "ar" | "zh";
export const LOCALES: Array<{ code: Locale; label: string }> = [
  { code: "en", label: "🇬🇧 English" },
  { code: "hi", label: "🇮🇳 हिन्दी" },
  { code: "ar", label: "🇸🇦 العربية" },
  { code: "zh", label: "🇨🇳 中文" },
];

type Dict = Record<string, string>;

const en: Dict = {
  tagline: "Digital products · instant delivery · best prices",
  hint: "👉 Tap 🛍 Shop, pick an item, then ⚡ Buy — that's it.",
  welcome: "👋 Welcome to Get It Sasta, {name}!",
  b_shop: "🛍 Shop", b_categories: "📂 Categories", b_search: "🔍 Search", b_cart: "🛒 Cart",
  b_orders: "📦 Orders", b_licenses: "🔑 My Licenses", b_wallet: "💳 Wallet", b_referral: "👥 Referral",
  b_support: "🎫 Support", b_language: "🌐 Language", b_help: "❓ Help", b_developer: "🧑‍💻 Developer API",
  b_reseller: "🏪 Reseller Hub", wallet_orders: "Wallet: {bal} · Orders: {n}",
  lang_title: "🌐 Choose your language:", lang_done: "✅ Language updated.",
  cur_title: "💱 Choose your currency:", cur_done: "✅ Currency set to {cur}.",
  b_currency: "💱 {cur}",
};
const hi: Dict = {
  tagline: "डिजिटल प्रोडक्ट्स · तुरंत डिलीवरी · बेहतरीन दाम",
  hint: "👉 🛍 शॉप पर टैप करें, आइटम चुनें, फिर ⚡ खरीदें — बस!",
  welcome: "👋 Get It Sasta में आपका स्वागत है, {name}!",
  b_shop: "🛍 शॉप", b_categories: "📂 श्रेणियाँ", b_search: "🔍 खोजें", b_cart: "🛒 कार्ट",
  b_orders: "📦 ऑर्डर", b_licenses: "🔑 मेरी लाइसेंस", b_wallet: "💳 वॉलेट", b_referral: "👥 रेफरल",
  b_support: "🎫 सहायता", b_language: "🌐 भाषा", b_help: "❓ मदद", b_developer: "🧑‍💻 डेवलपर API",
  b_reseller: "🏪 रीसेलर हब", wallet_orders: "वॉलेट: {bal} · ऑर्डर: {n}",
  lang_title: "🌐 अपनी भाषा चुनें:", lang_done: "✅ भाषा अपडेट हो गई।",
  cur_title: "💱 अपनी मुद्रा चुनें:", cur_done: "✅ मुद्रा {cur} पर सेट हुई।",
  b_currency: "💱 {cur}",
};
const ar: Dict = {
  tagline: "منتجات رقمية · تسليم فوري · أفضل الأسعار",
  hint: "👉 اضغط 🛍 المتجر، اختر منتجًا، ثم ⚡ اشترِ — هذا كل شيء.",
  welcome: "👋 مرحبًا بك في Get It Sasta، {name}!",
  b_shop: "🛍 المتجر", b_categories: "📂 الفئات", b_search: "🔍 بحث", b_cart: "🛒 السلة",
  b_orders: "📦 الطلبات", b_licenses: "🔑 تراخيصي", b_wallet: "💳 المحفظة", b_referral: "👥 الإحالة",
  b_support: "🎫 الدعم", b_language: "🌐 اللغة", b_help: "❓ مساعدة", b_developer: "🧑‍💻 واجهة المطور",
  b_reseller: "🏪 مركز الموزّع", wallet_orders: "المحفظة: {bal} · الطلبات: {n}",
  lang_title: "🌐 اختر لغتك:", lang_done: "✅ تم تحديث اللغة.",
  cur_title: "💱 اختر عملتك:", cur_done: "✅ تم ضبط العملة على {cur}.",
  b_currency: "💱 {cur}",
};
const zh: Dict = {
  tagline: "数字商品 · 即时交付 · 最优价格",
  hint: "👉 点击 🛍 商店，选择商品，然后 ⚡ 购买 — 就这么简单。",
  welcome: "👋 欢迎来到 Get It Sasta，{name}！",
  b_shop: "🛍 商店", b_categories: "📂 分类", b_search: "🔍 搜索", b_cart: "🛒 购物车",
  b_orders: "📦 订单", b_licenses: "🔑 我的许可", b_wallet: "💳 钱包", b_referral: "👥 推荐",
  b_support: "🎫 客服", b_language: "🌐 语言", b_help: "❓ 帮助", b_developer: "🧑‍💻 开发者 API",
  b_reseller: "🏪 分销中心", wallet_orders: "钱包：{bal} · 订单：{n}",
  lang_title: "🌐 选择你的语言：", lang_done: "✅ 语言已更新。",
  cur_title: "💱 选择你的货币：", cur_done: "✅ 货币已设为 {cur}。",
  b_currency: "💱 {cur}",
};

const DICTS: Record<Locale, Dict> = { en, hi, ar, zh };

export function t(locale: string | null | undefined, key: string, vars: Record<string, string | number> = {}): string {
  const loc = (locale && (locale in DICTS) ? locale : "en") as Locale;
  let str = DICTS[loc][key] ?? en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) str = str.replace(`{${k}}`, String(v));
  return str;
}
