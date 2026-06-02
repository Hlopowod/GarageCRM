import {
  authenticateRequest,
  CORS_HEADERS,
  getAdminClient,
  HttpError,
  jsonResponse,
  requireOwnedGarage,
} from "../_shared/billing.ts";

const VEHICLE_LIMIT_MESSAGE = "You have reached your monthly vehicle limit. Upgrade your plan to add more vehicles.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ message: "Method not allowed" }, 405);

  try {
    const supabase = getAdminClient();
    const user = await authenticateRequest(req, supabase);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "").trim();
    const garageId = String(body.garage_id || "").trim();

    await requireOwnedGarage(supabase, user.id, garageId, "id");

    if (action === "can_create_vehicle") {
      const { data, error } = await supabase.rpc("can_create_vehicle", { p_garage_id: garageId });
      if (error) throw new Error(error.message);
      return jsonResponse({ allowed: Boolean(data), message: Boolean(data) ? "" : VEHICLE_LIMIT_MESSAGE });
    }

    if (action === "increment_vehicle_usage") {
      const { error } = await supabase.rpc("increment_vehicle_usage", { p_garage_id: garageId });
      if (error) {
        if (String(error.message || "").includes("vehicle_limit_reached")) {
          throw new HttpError(VEHICLE_LIMIT_MESSAGE, 403);
        }
        throw new Error(error.message);
      }
      return jsonResponse({ ok: true });
    }

    throw new HttpError("Unsupported vehicle usage action.", 400);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unable to update vehicle usage.";
    console.error("vehicle-usage failed", message);
    return jsonResponse({ message }, status);
  }
});
