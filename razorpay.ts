// Razorpay integration — real server-side Orders API + HMAC signature check.
//
// Keys come from Web Admin → Secrets as RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET.
// `env` is imported LAZILY, inside the functions, for two reasons:
//   1. env reads DATABASE_URL at module load, and importing that from a router
//      leaf module made every unit test that imports appRouter fail on a
//      database variable it never touches.
//   2. An unset key must not take the app down — `razorpayConfigured()` simply
//      reports false and checkout offers Cash on Delivery only. Nothing on
//      screen ever claims a payment happened when it did not.
import { createHmac, timingSafeEqual } from "node:crypto";

const API = "https://api.razorpay.com/v1";

type EnvModule = typeof import("../_core/env");
let envPromise: Promise<EnvModule> | null = null;

function envModule(): Promise<EnvModule> {
  envPromise ??= import("../_core/env");
  return envPromise;
}

/** Reads a secret without throwing: missing key ⇒ undefined. */
async function readSecret(name: string): Promise<string | undefined> {
  try {
    const { env } = await envModule();
    return env.secret(name);
  } catch {
    return undefined;
  }
}

export async function razorpayConfigured(): Promise<boolean> {
  const [id, secret] = await Promise.all([readSecret("RAZORPAY_KEY_ID"), readSecret("RAZORPAY_KEY_SECRET")]);
  return Boolean(id && secret);
}

/** The publishable key id — safe to hand to the browser. Never the secret. */
export async function razorpayPublicKey(): Promise<string | null> {
  return (await readSecret("RAZORPAY_KEY_ID")) ?? null;
}

async function authHeader(): Promise<string> {
  const [id, secret] = await Promise.all([readSecret("RAZORPAY_KEY_ID"), readSecret("RAZORPAY_KEY_SECRET")]);
  if (!id || !secret) throw new Error("Razorpay keys are not configured.");
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

export type RazorpayOrder = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt?: string;
};

/**
 * Creates a Razorpay order. `amountPaise` is the order total in paise, which is
 * exactly the unit Razorpay expects (INR minor units).
 */
export async function createRazorpayOrder(input: {
  amountPaise: number;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<RazorpayOrder> {
  const { outboundFetch } = await import("../_core/fetch");

  const res = await outboundFetch(`${API}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: await authHeader() },
    body: JSON.stringify({
      amount: input.amountPaise,
      currency: "INR",
      receipt: input.receipt,
      notes: input.notes ?? {},
    }),
    timeoutMs: 15_000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Razorpay order failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as RazorpayOrder;
}

/**
 * Verifies the checkout callback signature.
 *
 * Razorpay signs `${razorpay_order_id}|${razorpay_payment_id}` with the key
 * secret. A mismatch means the callback did not come from Razorpay (or was
 * replayed against a different order) and the order must NOT be marked paid.
 */
export async function verifyRazorpaySignature(input: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  signature: string;
}): Promise<boolean> {
  const secret = await readSecret("RAZORPAY_KEY_SECRET");
  if (!secret) return false;

  const expected = createHmac("sha256", secret)
    .update(`${input.razorpayOrderId}|${input.razorpayPaymentId}`)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(input.signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
