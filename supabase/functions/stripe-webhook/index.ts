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
  const garageId = await findGarageId(supabase, {
    garageId: metadata.garage_id,
    subscriptionId,
    customerId,
  });

  if (!garageId) {
    console.warn("checkout.session.completed did not match a garage", { subscriptionId, customerId });
    return null;
  }

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

function invoiceSubscriptionId(invoice: StripeObject): string {
  const parent = invoice.parent as StripeObject | undefined;
  const subscriptionDetails = invoice.subscription_details as StripeObject | undefined;
  const parentSubscriptionDetails = parent?.subscription_details as StripeObject | undefined;
  return stripeId(invoice.subscription)
    || stripeId(subscriptionDetails?.subscription)
    || stripeId(parentSubscriptionDetails?.subscription);
}
