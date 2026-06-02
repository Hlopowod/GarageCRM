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
  retrieveCheckoutSession,
  retrieveSubscription,
  stripeId,
  subscriptionCurrentPeriodEndIso,
} from "../_shared/billing.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ message: "Method not allowed" }, 405);

  try {
    const supabase = getAdminClient();
    const user = await authenticateRequest(req, supabase);
    const body = await req.json().catch(() => ({}));
    const garageId = String(body.garage_id || "").trim();
    const sessionId = String(body.session_id || "").trim();

    if (!sessionId.startsWith("cs_")) {
      throw new HttpError("Checkout session is invalid.", 400);
    }

    await requireOwnedGarage(supabase, user.id, garageId, "id");

    const stripeSecretKey = requireEnv("STRIPE_SECRET_KEY");
    const checkoutSession = await retrieveCheckoutSession(stripeSecretKey, sessionId);
    if (!checkoutSession) throw new HttpError("Checkout session was not found.", 404);

    const metadata = getMetadata(checkoutSession);
    if (metadata.garage_id !== garageId || metadata.user_id !== user.id) {
      throw new HttpError("Checkout session does not belong to this garage.", 403);
    }

    const paymentStatus = String(checkoutSession.payment_status || "");
    const status = String(checkoutSession.status || "");
    const subscriptionId = stripeId(checkoutSession.subscription);
    if (status !== "complete" || paymentStatus !== "paid" || !subscriptionId) {
      return jsonResponse({
        synced: false,
        status,
        payment_status: paymentStatus,
        message: "Checkout is not complete yet.",
      });
    }

    const subscription = await retrieveSubscription(stripeSecretKey, subscriptionId);
    if (!subscription) throw new HttpError("Billing plan was not found.", 404);

    const plan = planFromSubscription(subscription, configuredStripePlanPrices());
    const subscriptionStatus = String(subscription.status || "unknown");

    const { error } = await supabase
      .from("garages")
      .update({
        plan,
        subscription_status: subscriptionStatus,
        stripe_customer_id: stripeId(subscription.customer) || stripeId(checkoutSession.customer) || null,
        stripe_subscription_id: String(subscription.id || "") || subscriptionId,
        current_period_end: subscriptionCurrentPeriodEndIso(subscription),
      })
      .eq("id", garageId);
    if (error) throw new Error(error.message);

    return jsonResponse({
      synced: true,
      plan,
      subscription_status: subscriptionStatus,
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unable to sync checkout session.";
    console.error("sync-checkout-session failed", message);
    return jsonResponse({ message }, status);
  }
});

function getMetadata(object: Record<string, unknown>): Record<string, string> {
  const metadata = object.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return metadata as Record<string, string>;
}
