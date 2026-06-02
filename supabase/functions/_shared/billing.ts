import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export function requireEnv(name: string): string {
  const value = (Deno.env.get(name) || "").trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export type BillingPlan = "pit_stop" | "service_bay" | "full_workshop" | "garage_empire";
export type StripePlanPrices = Record<Exclude<BillingPlan, "pit_stop">, string>;

export function normalizeBillingPlan(value: unknown): BillingPlan {
  const plan = String(value || "").trim().toLowerCase();
  if (plan === "service_bay" || plan === "basic") return "service_bay";
  if (plan === "full_workshop") return "full_workshop";
  if (plan === "garage_empire" || plan === "ultimate") return "garage_empire";
  return "pit_stop";
}

function optionalEnv(name: string): string {
  return (Deno.env.get(name) || "").trim();
}

export function priceIdForPlan(planValue: unknown): { plan: Exclude<BillingPlan, "pit_stop">; priceId: string } {
  const plan = normalizeBillingPlan(planValue);
  if (plan === "pit_stop") {
    throw new HttpError("plan must be service_bay, full_workshop, or garage_empire.", 400);
  }

  const envByPlan: Record<Exclude<BillingPlan, "pit_stop">, string> = {
    service_bay: "STRIPE_PRICE_SERVICE_BAY",
    full_workshop: "STRIPE_PRICE_FULL_WORKSHOP",
    garage_empire: "STRIPE_PRICE_GARAGE_EMPIRE",
  };
  const fallbackByPlan: Record<Exclude<BillingPlan, "pit_stop">, string> = {
    service_bay: "STRIPE_PRICE_BASIC",
    full_workshop: "",
    garage_empire: "STRIPE_PRICE_ULTIMATE",
  };

  const envName = envByPlan[plan];
  const fallbackName = fallbackByPlan[plan];
  const priceId = optionalEnv(envName) || (fallbackName ? optionalEnv(fallbackName) : "");
  if (!priceId) {
    throw new Error(`${envName}${fallbackName ? ` or ${fallbackName}` : ""} is not configured.`);
  }

  return { plan, priceId };
}

export function configuredStripePlanPrices(): StripePlanPrices {
  return {
    service_bay: optionalEnv("STRIPE_PRICE_SERVICE_BAY") || optionalEnv("STRIPE_PRICE_BASIC"),
    full_workshop: optionalEnv("STRIPE_PRICE_FULL_WORKSHOP"),
    garage_empire: optionalEnv("STRIPE_PRICE_GARAGE_EMPIRE") || optionalEnv("STRIPE_PRICE_ULTIMATE"),
  };
}

export function getAdminClient() {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function authenticateRequest(req: Request, supabase: ReturnType<typeof createClient>) {
  const authHeader = req.headers.get("Authorization") || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) throw new HttpError("Missing user access token.", 401);

  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data.user) throw new HttpError("Invalid user session.", 401);
  return data.user;
}

export async function requireOwnedGarage(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  garageId: string,
  select = "*",
) {
  if (!isUuid(garageId)) throw new HttpError("garage_id must be a valid UUID.", 400);

  const { data, error } = await supabase
    .from("garages")
    .select(select)
    .eq("id", garageId)
    .eq("owner_user_id", userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new HttpError("Garage not found for this user.", 404);
  return data as Record<string, unknown>;
}

export function getAppUrl(): string {
  const value = (Deno.env.get("APP_URL") || Deno.env.get("FRONTEND_URL") || "").trim();
  if (!value) throw new Error("APP_URL or FRONTEND_URL is not configured.");
  return value.replace(/\/+$/, "");
}

export function getBillingReturnUrl(): string {
  const configured = (Deno.env.get("BILLING_RETURN_URL") || "").trim();
  if (configured) return configured.replace(/\/+$/, "");

  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").trim();
  if (supabaseUrl) {
    return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/billing-return`;
  }

  return getAppUrl();
}

export function stripeForm(fields: Record<string, unknown>): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    form.set(key, typeof value === "boolean" ? String(value) : String(value));
  }
  return form;
}

export async function stripePost(
  secretKey: string,
  path: string,
  body: URLSearchParams,
): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  return readStripeJson(response);
}

export async function stripeGet(secretKey: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  return readStripeJson(response);
}

async function readStripeJson(response: Response): Promise<Record<string, unknown>> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const stripeError = data && typeof data === "object" && "error" in data
      ? (data.error as Record<string, unknown>)
      : {};
    const message = String(stripeError.message || data.message || "Payment request failed.");
    throw new HttpError(message, response.status);
  }
  return data as Record<string, unknown>;
}

export async function retrieveSubscription(secretKey: string, subscriptionId: string) {
  if (!subscriptionId) return null;
  const encoded = encodeURIComponent(subscriptionId);
  return await stripeGet(secretKey, `/subscriptions/${encoded}?expand[]=items.data.price`);
}

export async function retrieveCheckoutSession(secretKey: string, sessionId: string) {
  if (!sessionId) return null;
  const encoded = encodeURIComponent(sessionId);
  return await stripeGet(secretKey, `/checkout/sessions/${encoded}`);
}

export async function retrieveCustomerSubscriptions(secretKey: string, customerId: string) {
  if (!customerId) return [];
  const encoded = encodeURIComponent(customerId);
  const response = await stripeGet(
    secretKey,
    `/subscriptions?customer=${encoded}&status=all&limit=20&expand[]=data.items.data.price`,
  );
  return Array.isArray(response.data) ? response.data as Record<string, unknown>[] : [];
}

export function planFromPriceId(priceId: string, prices: StripePlanPrices): BillingPlan {
  if (priceId && priceId === prices.service_bay) return "service_bay";
  if (priceId && priceId === prices.full_workshop) return "full_workshop";
  if (priceId && priceId === prices.garage_empire) return "garage_empire";
  return "pit_stop";
}

export function planFromSubscription(
  subscription: Record<string, unknown> | null,
  prices: StripePlanPrices,
): BillingPlan {
  if (!subscription) return "pit_stop";
  if (!subscriptionHasPaidPeriodAccess(subscription)) return "pit_stop";
  return planFromPriceId(subscriptionPriceId(subscription), prices);
}

export function subscriptionHasPaidPeriodAccess(subscription: Record<string, unknown> | null): boolean {
  if (!subscription) return false;
  const status = String(subscription.status || "");
  if (status === "active" || status === "trialing") return true;
  const currentPeriodEndSeconds = subscriptionCurrentPeriodEndSeconds(subscription);
  return Number.isFinite(currentPeriodEndSeconds) && currentPeriodEndSeconds * 1000 > Date.now();
}

export function subscriptionCurrentPeriodEndIso(subscription: Record<string, unknown> | null): string | null {
  return stripeTimestampToIso(subscriptionCurrentPeriodEndSeconds(subscription));
}

export function subscriptionCurrentPeriodEndSeconds(subscription: Record<string, unknown> | null): number {
  if (!subscription) return 0;

  const direct = stripeTimestampSeconds(subscription.current_period_end);
  if (direct > 0) return direct;

  const currentPeriod = subscription.current_period as Record<string, unknown> | undefined;
  const nested = stripeTimestampSeconds(currentPeriod?.end);
  if (nested > 0) return nested;

  const items = subscription.items as Record<string, unknown> | undefined;
  const itemRows = Array.isArray(items?.data) ? items.data : [];
  for (const item of itemRows) {
    const row = item as Record<string, unknown>;
    const itemDirect = stripeTimestampSeconds(row.current_period_end);
    if (itemDirect > 0) return itemDirect;

    const itemPeriod = row.current_period as Record<string, unknown> | undefined;
    const itemNested = stripeTimestampSeconds(itemPeriod?.end);
    if (itemNested > 0) return itemNested;
  }

  const trialEnd = stripeTimestampSeconds(subscription.trial_end);
  if (trialEnd > 0) return trialEnd;

  return 0;
}

export function subscriptionPriceId(subscription: Record<string, unknown> | null): string {
  const items = subscription?.items as Record<string, unknown> | undefined;
  const data = Array.isArray(items?.data) ? items.data : [];
  const firstItem = data[0] as Record<string, unknown> | undefined;
  const price = firstItem?.price as Record<string, unknown> | undefined;
  return String(price?.id || "");
}

export function stripeId(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    return String((value as Record<string, unknown>).id || "");
  }
  return "";
}

export function stripeTimestampToIso(value: unknown): string | null {
  const seconds = stripeTimestampSeconds(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

export function stripeTimestampSeconds(value: unknown): number {
  const seconds = Number(value || 0);
  return Number.isFinite(seconds) ? seconds : 0;
}

export async function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  webhookSecret: string,
): Promise<boolean> {
  const pieces = signatureHeader.split(",").map(part => part.trim());
  const timestamp = pieces.find(part => part.startsWith("t="))?.slice(2) || "";
  const signatures = pieces
    .filter(part => part.startsWith("v1="))
    .map(part => part.slice(3));

  if (!timestamp || signatures.length === 0) return false;

  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - timestampNumber);
  if (ageSeconds > 300) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${payload}`));
  const expected = bytesToHex(new Uint8Array(signature));
  return signatures.some(candidate => timingSafeEqual(candidate, expected));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class HttpError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}
