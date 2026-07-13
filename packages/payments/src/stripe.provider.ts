// Removed by product decision (2026-07-14): payment methods are UPI (Razorpay)
// and crypto (NOWPayments) only. The PaymentProvider abstraction in types.ts
// is gateway-agnostic; a card gateway can be reintroduced as a new file
// implementing PaymentProvider without touching business logic.
export {};
