import {
  CORS_HEADERS,
  configuredStripePlanPrices,
  getAdminClient,
  HttpError,
  jsonResponse,
  normalizeBillingPlan,
  planFromPriceId,
  planFromSubscription,
  requireEnv,
  retrieveSubscription,
  stripeId,
  stripeTimestampToIso,
  subscriptionCurrentPeriodEndIso,
  subscriptionPriceId,
  verifyStripeSignature,
} from "../_shared/billing.ts";

type SupabaseAdmin = ReturnType<typeof getAdminClient>;
type StripeObject = Record<string, unknown>;
type StripeEvent = {
  id: string;
  type: string;
  data?: { object?: StripeObject };
};

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ message: "Method not allowed" }, 405);

  try {
    const payload = await req.text();
    const signature = req.headers.get("stripe-signature") || "";
    const webhookSecret = requireEnv("STRIPE_WEBHOOK_SECRET");
    const signatureOk = await verifyStripeSignature(payload, signature, webhookSecret);
    if (!signatureOk) throw new HttpError("Invalid billing webhook signature.", 400);

    const event = JSON.parse(payload) as StripeEvent;
    if (!event.id || !event.type) throw new HttpError("Invalid billing event payload.", 400);

    const supabase = getAdminClient();
    const { data: existingEvent, error: existingError } = await supabase
      .from("billing_events")
      .select("id")
      .eq("stripe_event_id", event.id)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (existingEvent) return jsonResponse({ received: true, duplicate: true });

    const garageId = await handleStripeEvent(event, supabase);

    const { error: insertError } = await supabase.from("billing_events").insert({
      garage_id: garageId,
      stripe_event_id: event.id,
      event_type: event.type,
      raw_event: event,
    });
    if (insertError && insertError.code !== "23505") throw new Error(insertError.message);

    return jsonResponse({ received: true });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unable to process billing update.";
    console.error("stripe-webhook failed", message);
    return jsonResponse({ message }, status);
  }
});

async function handleStripeEvent(event: StripeEvent, supabase: SupabaseAdmin): Promise<string | null> {
  const object = event.data?.object || {};
  if (event.type === "checkout.session.completed") {
    return await syncCheckoutSession(object, supabase);
  }
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    return await syncSubscription(object, supabase, event.type);
  }
  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    return await syncInvoice(object, supabase, event.type);
  }
  return null;
}

async function syncCheckoutSession(session: StripeObject, supabase: SupabaseAdmin): Promise<string | null> {
  const stripeSecretKey = requireEnv("STRIPE_SECRET_KEY");
  const metadata = getMetadata(session);
  const subscriptionId = stripeId(session.subscription);
  const customerId = stripeId(session.customer);
  const subscription = subscriptionId ? await retrieveSubscription(stripeSecretKey, subscriptionId) : null;
  const subscriptionMetadata = subscription ? getMetadata(subscription) : {};
  const garageId = await findGarageId(supabase, {
    garageId: metadata.garage_id,
    subscriptionId,
    customerId,
  });

  if (!garageId) {
    console.warn("checkout.session.completed did not match a garage", { subscriptionId, customerId });
    return null;
  }

  await recordReferralAttribution(supabase, {
    referralCodeId: metadata.referral_code_id || subscriptionMetadata.referral_code_id,
    referralCode: metadata.referral_code || subscriptionMetadata.referral_code,
    userId: metadata.user_id || subscriptionMetadata.user_id,
    garageId,
    customerId,
    subscriptionId,
    checkoutSessionId: String(session.id || ""),
  });

  if (subscription) {
    await updateGarageFromSubscription(supabase, garageId, subscription, "checkout.session.completed");
    return garageId;
  }

  const requestedPlan = normalizeBillingPlan(metadata.plan);
  await updateGarage(supabase, garageId, {
    plan: requestedPlan,
    subscription_status: "active",
    stripe_customer_id: customerId || null,
    stripe_subscription_id: subscriptionId || null,
    current_period_end: null,
  });
  return garageId;
}

async function syncSubscription(
  subscription: StripeObject,
  supabase: SupabaseAdmin,
  eventType: string,
): Promise<string | null> {
  const customerId = stripeId(subscription.customer);
  const garageId = await findGarageId(supabase, {
    garageId: getMetadata(subscription).garage_id,
    subscriptionId: String(subscription.id || ""),
    customerId,
  });

  if (!garageId) {
    console.warn(`${eventType} did not match a garage`, { subscriptionId: subscription.id, customerId });
    return null;
  }

  await updateGarageFromSubscription(supabase, garageId, subscription, eventType);
  return garageId;
}

async function syncInvoice(
  invoice: StripeObject,
  supabase: SupabaseAdmin,
  eventType: string,
): Promise<string | null> {
  const stripeSecretKey = requireEnv("STRIPE_SECRET_KEY");
  const subscriptionId = invoiceSubscriptionId(invoice);
  const customerId = stripeId(invoice.customer);

  if (subscriptionId) {
    const subscription = await retrieveSubscription(stripeSecretKey, subscriptionId);
    if (subscription) {
      const garageId = await findGarageId(supabase, {
        garageId: getMetadata(subscription).garage_id,
        subscriptionId,
        customerId,
      });
      if (garageId) {
        await updateGarageFromSubscription(supabase, garageId, subscription, eventType);
        if (eventType === "invoice.paid") {
          await recordReferralCommission(supabase, invoice, subscription, garageId);
        }
        return garageId;
      }
    }
  }

  const garageId = await findGarageId(supabase, { customerId });
  if (garageId && eventType === "invoice.payment_failed") {
    await updateGarage(supabase, garageId, {
      plan: "pit_stop",
      subscription_status: "payment_failed",
    });
  }
  return garageId;
}

type ReferralAttributionInput = {
  referralCodeId?: string;
  referralCode?: string;
  userId?: string;
  garageId: string;
  customerId?: string;
  subscriptionId?: string;
  checkoutSessionId?: string;
};

type ReferralAttributionRow = {
  id: string;
  referral_code_id: string;
  attributed_at: string;
  user_id: string | null;
};

async function recordReferralAttribution(
  supabase: SupabaseAdmin,
  input: ReferralAttributionInput,
): Promise<ReferralAttributionRow | null> {
  if (!input.garageId) return null;

  const existing = await fetchReferralAttribution(supabase, input.garageId);
  if (existing) return existing;

  const code = await resolveReferralCode(supabase, input.referralCodeId, input.referralCode);
  if (!code) return null;

  const { data, error } = await supabase
    .from("referral_attributions")
    .insert({
      referral_code_id: code.id,
      code: code.code,
      user_id: input.userId || null,
      garage_id: input.garageId,
      stripe_customer_id: input.customerId || null,
      stripe_subscription_id: input.subscriptionId || null,
      first_checkout_session_id: input.checkoutSessionId || null,
    })
    .select("id, referral_code_id, attributed_at, user_id")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") return await fetchReferralAttribution(supabase, input.garageId);
    throw new Error(error.message);
  }

  return data as ReferralAttributionRow | null;
}

async function fetchReferralAttribution(
  supabase: SupabaseAdmin,
  garageId: string,
): Promise<ReferralAttributionRow | null> {
  const { data, error } = await supabase
    .from("referral_attributions")
    .select("id, referral_code_id, attributed_at, user_id")
    .eq("garage_id", garageId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as ReferralAttributionRow | null;
}

async function resolveReferralCode(
  supabase: SupabaseAdmin,
  referralCodeId?: string,
  referralCode?: string,
  requireActive = true,
): Promise<{ id: string; code: string; commission_percent: number; payout_months: number } | null> {
  let query = supabase
    .from("referral_codes")
    .select("id, code, commission_percent, payout_months, status");

  const id = String(referralCodeId || "").trim();
  const code = normalizeReferralCode(referralCode);
  if (id) {
    query = query.eq("id", id);
  } else if (code) {
    query = query.eq("code", code);
  } else {
    return null;
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  if (requireActive && data.status !== "active") return null;
  return {
    id: String(data.id),
    code: String(data.code),
    commission_percent: Number(data.commission_percent || 0),
    payout_months: Number(data.payout_months || 0),
  };
}

async function recordReferralCommission(
  supabase: SupabaseAdmin,
  invoice: StripeObject,
  subscription: StripeObject,
  garageId: string,
): Promise<void> {
  const subscriptionMetadata = getMetadata(subscription);
  const subscriptionId = invoiceSubscriptionId(invoice) || String(subscription.id || "");
  const customerId = stripeId(invoice.customer) || stripeId(subscription.customer);
  let attribution = await fetchReferralAttribution(supabase, garageId);

  if (!attribution) {
    attribution = await recordReferralAttribution(supabase, {
      referralCodeId: subscriptionMetadata.referral_code_id,
      referralCode: subscriptionMetadata.referral_code,
      userId: subscriptionMetadata.user_id,
      garageId,
      customerId,
      subscriptionId,
    });
  }
  if (!attribution) return;

  const referralCode = await resolveReferralCode(supabase, attribution.referral_code_id, undefined, false);
  if (!referralCode) return;

  const invoiceId = String(invoice.id || "");
  if (!invoiceId) return;

  const invoiceAmountCents = Math.max(0, toInteger(invoice.amount_paid || invoice.total || invoice.amount_due));
  if (invoiceAmountCents <= 0) return;

  const invoiceCreatedAt = stripeTimestampToIso(invoice.created) || new Date().toISOString();
  const payoutMonthIndex = getPayoutMonthIndex(attribution.attributed_at, invoiceCreatedAt);
  if (payoutMonthIndex < 1 || payoutMonthIndex > referralCode.payout_months) return;

  const commissionAmountCents = Math.round(invoiceAmountCents * (referralCode.commission_percent / 100));
  if (commissionAmountCents <= 0) return;

  const { error } = await supabase
    .from("referral_commissions")
    .insert({
      referral_code_id: referralCode.id,
      attribution_id: attribution.id,
      garage_id: garageId,
      user_id: attribution.user_id,
      stripe_invoice_id: invoiceId,
      stripe_subscription_id: subscriptionId || null,
      stripe_customer_id: customerId || null,
      invoice_amount_cents: invoiceAmountCents,
      currency: String(invoice.currency || "gbp").toLowerCase(),
      commission_percent: referralCode.commission_percent,
      commission_amount_cents: commissionAmountCents,
      payout_month_index: payoutMonthIndex,
      invoice_created_at: invoiceCreatedAt,
      period_start: stripeTimestampToIso(invoice.period_start),
      period_end: stripeTimestampToIso(invoice.period_end),
      status: "pending",
    });

  if (error && error.code !== "23505") throw new Error(error.message);
}

async function updateGarageFromSubscription(
  supabase: SupabaseAdmin,
  garageId: string,
  subscription: StripeObject,
  eventType: string,
) {
  const prices = configuredStripePlanPrices();
  const status = eventType === "customer.subscription.deleted"
    ? "canceled"
    : String(subscription.status || "unknown");
  const mappedPlan = planFromSubscription(subscription, prices);
  const subscriptionId = mappedPlan === "pit_stop" && status !== "active" && status !== "trialing"
    ? null
    : String(subscription.id || "") || null;
  const currentPeriodEnd = subscriptionCurrentPeriodEndIso(subscription);
  const customerId = stripeId(subscription.customer);

  await updateGarage(supabase, garageId, {
    plan: mappedPlan,
    subscription_status: status,
    stripe_customer_id: customerId || null,
    stripe_subscription_id: subscriptionId,
    current_period_end: currentPeriodEnd,
  });

  const priceId = subscriptionPriceId(subscription);
  const knownPlan = planFromPriceId(priceId, prices);
  if (priceId && knownPlan === "pit_stop") {
    console.warn("Stripe subscription price does not match configured plan prices", {
      garageId,
      subscriptionId: subscription.id,
      priceId,
    });
  }
}

async function updateGarage(supabase: SupabaseAdmin, garageId: string, updates: Record<string, unknown>) {
  const { error } = await supabase
    .from("garages")
    .update(updates)
    .eq("id", garageId);
  if (error) throw new Error(error.message);
}

async function findGarageId(
  supabase: SupabaseAdmin,
  refs: { garageId?: unknown; subscriptionId?: string; customerId?: string },
): Promise<string | null> {
  const metadataGarageId = String(refs.garageId || "").trim();
  if (metadataGarageId) {
    const { data, error } = await supabase
      .from("garages")
      .select("id")
      .eq("id", metadataGarageId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.id) return String(data.id);
  }

  if (refs.subscriptionId) {
    const { data, error } = await supabase
      .from("garages")
      .select("id")
      .eq("stripe_subscription_id", refs.subscriptionId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.id) return String(data.id);
  }

  if (refs.customerId) {
    const { data, error } = await supabase
      .from("garages")
      .select("id")
      .eq("stripe_customer_id", refs.customerId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.id) return String(data.id);
  }

  return null;
}

function getMetadata(object: StripeObject): Record<string, string> {
  const metadata = object.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return metadata as Record<string, string>;
}

function normalizeReferralCode(value: unknown): string {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 32);
}

function toInteger(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function getPayoutMonthIndex(attributedAt: string, invoiceCreatedAt: string): number {
  const start = new Date(attributedAt);
  const end = new Date(invoiceCreatedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;
  const monthDiff = (end.getUTCFullYear() - start.getUTCFullYear()) * 12
    + (end.getUTCMonth() - start.getUTCMonth());
  return Math.max(1, monthDiff + 1);
}

function invoiceSubscriptionId(invoice: StripeObject): string {
  const parent = invoice.parent as StripeObject | undefined;
  const subscriptionDetails = invoice.subscription_details as StripeObject | undefined;
  const parentSubscriptionDetails = parent?.subscription_details as StripeObject | undefined;
  return stripeId(invoice.subscription)
    || stripeId(subscriptionDetails?.subscription)
    || stripeId(parentSubscriptionDetails?.subscription);
}
