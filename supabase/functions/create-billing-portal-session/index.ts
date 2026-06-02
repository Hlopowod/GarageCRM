import {
  authenticateRequest,
  CORS_HEADERS,
  getAdminClient,
  getBillingReturnUrl,
  HttpError,
  jsonResponse,
  requireEnv,
  requireOwnedGarage,
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
    const garageId = String(body.garage_id || "").trim();
    const garage = await requireOwnedGarage(
      supabase,
      user.id,
      garageId,
      "id, stripe_customer_id",
    );
    const customerId = String(garage.stripe_customer_id || "");
    if (!customerId) {
      throw new HttpError("No billing profile exists for this garage yet.", 400);
    }

    const returnUrl = getBillingReturnUrl();
    let portal: Record<string, unknown>;
    try {
      portal = await stripePost(requireEnv("STRIPE_SECRET_KEY"), "/billing_portal/sessions", stripeForm({
        customer: customerId,
        return_url: `${returnUrl}?status=portal-return`,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      if (!/no such customer/i.test(message)) throw error;

      await clearStripeBillingReferences(supabase, garageId);
      throw new HttpError(
        "This billing profile belongs to Stripe test mode. Start a new live checkout to create a live billing profile.",
        409,
      );
    }

    const url = String(portal.url || "");
    if (!url) throw new Error("The billing portal is not ready yet.");

    return jsonResponse({ url });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unable to create billing portal session.";
    console.error("create-billing-portal-session failed", message);
    return jsonResponse({ message }, status);
  }
});

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
