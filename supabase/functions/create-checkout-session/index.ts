import {
  authenticateRequest,
  CORS_HEADERS,
  getAdminClient,
  getBillingReturnUrl,
  HttpError,
  jsonResponse,
  requireOwnedGarage,
  priceIdForPlan,
  requireEnv,
  stripeForm,
  stripePost,
} from "../_shared/billing.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ message: "Method not allowed" }, 405);

  try {
    const supabase = getAdminClient();
    const user = await authenticateRequest(req, supabase);
    const body = await req.json().catch(() => ({}));
    const requestedPlan = String(body.plan || "").trim().toLowerCase();
    const garageId = String(body.garage_id || "").trim();
    const requestedReferralCode = normalizeReferralCode(body.referral_code);

    const { plan, priceId } = priceIdForPlan(requestedPlan);
    const stripeSecretKey = requireEnv("STRIPE_SECRET_KEY");
    const returnUrl = getBillingReturnUrl();
    const garage = await requireOwnedGarage(
      supabase,
      user.id,
      garageId,
      "id, owner_user_id, name, email, stripe_customer_id",
    );
    const referral = requestedReferralCode
      ? await requireActiveReferralCode(supabase, requestedReferralCode)
      : null;

    let customerId = String(garage.stripe_customer_id || "");
    if (!customerId) {
      customerId = await createStripeCustomer(stripeSecretKey, supabase, garage, user, garageId, referral);
    }

    let session: Record<string, unknown>;
    try {
      session = await createStripeCheckoutSession(stripeSecretKey, {
        customerId,
        priceId,
        returnUrl,
        userId: user.id,
        garageId,
        plan,
        referral,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      if (!/no such customer/i.test(message)) throw error;

      customerId = await createStripeCustomer(stripeSecretKey, supabase, garage, user, garageId, referral);
      session = await createStripeCheckoutSession(stripeSecretKey, {
        customerId,
        priceId,
        returnUrl,
        userId: user.id,
        garageId,
        plan,
        referral,
      });
    }

    const url = String(session.url || "");
    if (!url) throw new Error("The checkout page is not ready yet.");

    return jsonResponse({ url, session_id: String(session.id || "") });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unable to create checkout session.";
    console.error("create-checkout-session failed", message);
    return jsonResponse({ message }, status);
  }
});

async function createStripeCustomer(
  stripeSecretKey: string,
  supabase: ReturnType<typeof getAdminClient>,
  garage: Record<string, unknown>,
  user: { id: string; email?: string },
  garageId: string,
  referral: ReferralCode | null,
): Promise<string> {
  const customer = await stripePost(stripeSecretKey, "/customers", stripeForm({
    email: garage.email || user.email || undefined,
    name: garage.name || "Garage CRM",
    "metadata[user_id]": user.id,
    "metadata[garage_id]": garageId,
    "metadata[referral_code]": referral?.code,
    "metadata[referral_code_id]": referral?.id,
  }));
  const customerId = String(customer.id || "");
  if (!customerId) throw new Error("The billing profile is not ready yet.");

  const { error: updateError } = await supabase
    .from("garages")
    .update({ stripe_customer_id: customerId })
    .eq("id", garageId);
  if (updateError) throw new Error(updateError.message);

  return customerId;
}

async function createStripeCheckoutSession(
  stripeSecretKey: string,
  input: {
    customerId: string;
    priceId: string;
    returnUrl: string;
    userId: string;
    garageId: string;
    plan: string;
    referral: ReferralCode | null;
  },
): Promise<Record<string, unknown>> {
  return await stripePost(stripeSecretKey, "/checkout/sessions", stripeForm({
    mode: "subscription",
    customer: input.customerId,
    "payment_method_types[0]": "card",
    "line_items[0][price]": input.priceId,
    "line_items[0][quantity]": 1,
    allow_promotion_codes: true,
    success_url: `${input.returnUrl}?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.returnUrl}?status=cancelled`,
    "metadata[user_id]": input.userId,
    "metadata[garage_id]": input.garageId,
    "metadata[plan]": input.plan,
    "metadata[referral_code]": input.referral?.code,
    "metadata[referral_code_id]": input.referral?.id,
    "subscription_data[metadata][user_id]": input.userId,
    "subscription_data[metadata][garage_id]": input.garageId,
    "subscription_data[metadata][plan]": input.plan,
    "subscription_data[metadata][referral_code]": input.referral?.code,
    "subscription_data[metadata][referral_code_id]": input.referral?.id,
  }));
}

type ReferralCode = {
  id: string;
  code: string;
};

function normalizeReferralCode(value: unknown): string {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 32);
}

async function requireActiveReferralCode(
  supabase: ReturnType<typeof getAdminClient>,
  code: string,
): Promise<ReferralCode> {
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) {
    throw new HttpError("Referral code is invalid.", 400);
  }

  const { data, error } = await supabase
    .from("referral_codes")
    .select("id, code, status")
    .eq("code", code)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data || data.status !== "active") {
    throw new HttpError("Referral code is not active.", 400);
  }

  return {
    id: String(data.id),
    code: String(data.code),
  };
}
