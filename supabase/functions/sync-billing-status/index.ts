import {
  authenticateRequest,
  CORS_HEADERS,
  configuredStripePlanPrices,
  getAdminClient,
  HttpError,
  jsonResponse,
  planFromSubscription,
  requireEnv,
  requireOwnedGarage,
  retrieveCustomerSubscriptions,
  retrieveSubscription,
  stripeId,
  subscriptionCurrentPeriodEndIso,
  subscriptionCurrentPeriodEndSeconds,
  subscriptionHasPaidPeriodAccess,
} from "../_shared/billing.ts";

type StripeObject = Record<string, unknown>;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ message: "Method not allowed" }, 405);

  try {
    const supabase = getAdminClient();
    const user = await authenticateRequest(req, supabase);
    const body = await req.json().catch(() => ({}));
    const garageId = String(body.garage_id || "").trim();
    const garage = await requireOwnedGarage(
      supabase,
      user.id,
      garageId,
      "id, stripe_customer_id, stripe_subscription_id",
    );

    const stripeSecretKey = requireEnv("STRIPE_SECRET_KEY");
    const subscriptionId = String(garage.stripe_subscription_id || "");
    const customerId = String(garage.stripe_customer_id || "");
    let subscription: StripeObject | null = null;

    try {
      subscription = subscriptionId ? await retrieveSubscription(stripeSecretKey, subscriptionId) : null;

      if (!subscription && customerId) {
        const subscriptions = await retrieveCustomerSubscriptions(stripeSecretKey, customerId);
        subscription = chooseBestSubscription(subscriptions, garageId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      if (!/no such (customer|subscription)/i.test(message)) throw error;

      await clearStripeBillingReferences(supabase, garageId);
      return jsonResponse({
        synced: false,
        cleared: true,
        message: "Old Stripe test billing profile was cleared. Start a new live checkout.",
      });
    }

    if (!subscription) {
      return jsonResponse({
        synced: false,
        message: "No Stripe subscription was found for this garage.",
      });
    }

    const prices = configuredStripePlanPrices();
    const plan = planFromSubscription(subscription, prices);
    const subscriptionStatus = String(subscription.status || "unknown");
    const customer = stripeId(subscription.customer) || customerId || null;
    const currentPeriodEnd = subscriptionCurrentPeriodEndIso(subscription);
    const nextSubscriptionId = plan === "pit_stop" && !subscriptionHasPaidPeriodAccess(subscription)
      ? null
      : String(subscription.id || "") || subscriptionId || null;

    const { error } = await supabase
      .from("garages")
      .update({
        plan,
        subscription_status: subscriptionStatus,
        stripe_customer_id: customer,
        stripe_subscription_id: nextSubscriptionId,
        current_period_end: currentPeriodEnd,
      })
      .eq("id", garageId);
    if (error) throw new Error(error.message);

    return jsonResponse({
      synced: true,
      plan,
      subscription_status: subscriptionStatus,
      current_period_end: currentPeriodEnd,
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unable to sync billing status.";
    console.error("sync-billing-status failed", message);
    return jsonResponse({ message }, status);
  }
});

function chooseBestSubscription(subscriptions: StripeObject[], garageId: string): StripeObject | null {
  const candidates = subscriptions
    .map(subscription => ({ subscription, score: scoreSubscription(subscription, garageId) }))
    .filter(item => item.score >= 0)
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.subscription || null;
}

function scoreSubscription(subscription: StripeObject, garageId: string): number {
  const metadata = getMetadata(subscription);
  if (metadata.garage_id && metadata.garage_id !== garageId) return -1;

  const status = String(subscription.status || "");
  const currentPeriodEnd = subscriptionCurrentPeriodEndSeconds(subscription);
  const created = Number(subscription.created || 0);
  let score = Number.isFinite(currentPeriodEnd) ? currentPeriodEnd : 0;
  if (status === "active" || status === "trialing") score += 2_000_000_000;
  else if (subscriptionHasPaidPeriodAccess(subscription)) score += 1_000_000_000;
  return score + (Number.isFinite(created) ? created / 10_000 : 0);
}

function getMetadata(object: StripeObject): Record<string, string> {
  const metadata = object.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return metadata as Record<string, string>;
}

async function clearStripeBillingReferences(
  supabase: ReturnType<typeof getAdminClient>,
  garageId: string,
) {
  const { error } = await supabase
    .from("garages")
    .update({
      stripe_customer_id: null,
      stripe_subscription_id: null,
      current_period_end: null,
    })
    .eq("id", garageId);
  if (error) throw new Error(error.message);
}
