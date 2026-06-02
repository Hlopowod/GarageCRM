import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DVLA_ENDPOINT = "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles";
const VRM_CREDIT_MESSAGE = "VRM checks are not available on your current plan or monthly VRM checks are used up.";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
}

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeRegistration(value: unknown) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeDate(value: unknown) {
  const date = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function mapDvlaVehicle(raw: Record<string, unknown>, registrationNumber: string) {
  const engineCapacity = Number(raw.engineCapacity || 0);
  const yearOfManufacture = Number(raw.yearOfManufacture || 0);

  return {
    registrationNumber: normalizeRegistration(raw.registrationNumber || registrationNumber),
    make: String(raw.make || "").trim(),
    model: "",
    yearOfManufacture: Number.isFinite(yearOfManufacture) && yearOfManufacture > 0 ? yearOfManufacture : 0,
    engineCapacity: Number.isFinite(engineCapacity) && engineCapacity > 0 ? engineCapacity : 0,
    engine: Number.isFinite(engineCapacity) && engineCapacity > 0 ? `${engineCapacity} cc` : "",
    fuelType: String(raw.fuelType || "").trim(),
    colour: String(raw.colour || "").trim(),
    motStatus: String(raw.motStatus || "").trim(),
    motExpiryDate: normalizeDate(raw.motExpiryDate),
    taxStatus: String(raw.taxStatus || "").trim(),
    taxDueDate: normalizeDate(raw.taxDueDate),
    monthOfFirstRegistration: String(raw.monthOfFirstRegistration || "").trim(),
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { message: text };
  }
}

function mapDvlaError(status: number, body: Record<string, unknown>) {
  const rawMessage = String(body.detail || body.message || body.title || "").trim();
  if (status === 400) return "Enter a valid registration number and try again.";
  if (status === 404) return "No vehicle found for this registration.";
  if (status === 429) return "Vehicle lookup is busy. Try again in a moment.";
  if (status >= 500) return "Vehicle lookup is unavailable right now. Try again later.";
  return rawMessage || "DVLA lookup failed. Check the registration and try again.";
}

async function getGarageIdForUser(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("garages")
    .select("id")
    .eq("owner_user_id", userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return String(data?.id || "");
}

async function canUseVrmCheck(
  supabase: ReturnType<typeof createClient>,
  garageId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("can_check_vrm", { p_garage_id: garageId });
  if (error) throw new Error(error.message);
  return Boolean(data);
}

async function incrementVrmUsage(
  supabase: ReturnType<typeof createClient>,
  garageId: string,
): Promise<boolean> {
  const { error } = await supabase.rpc("increment_vrm_usage", { p_garage_id: garageId });
  if (error) {
    console.error("Unable to increment VRM usage", error.message);
    return false;
  }
  return true;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Use POST for DVLA vehicle lookup." }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const dvlaApiKey = Deno.env.get("DVLA_API_KEY") || "";
  if (!supabaseUrl || !serviceRoleKey || !dvlaApiKey) {
    return jsonResponse({ error: "DVLA lookup service is not configured." }, 500);
  }

  const authHeader = req.headers.get("Authorization") || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) {
    return jsonResponse({ error: "Sign in before checking DVLA." }, 401);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: authData, error: authError } = await supabase.auth.getUser(accessToken);
  if (authError || !authData.user) {
    return jsonResponse({ error: "Your session expired. Sign in again." }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    const parsedBody = await req.json();
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return jsonResponse({ error: "Request body must be a JSON object." }, 400);
    }
    body = parsedBody as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Request body must be JSON." }, 400);
  }

  const registrationNumber = normalizeRegistration(body.registrationNumber || body.registration);
  if (!registrationNumber) {
    return jsonResponse({ error: "Registration number is required." }, 400);
  }

  let garageId = "";
  try {
    garageId = await getGarageIdForUser(supabase, authData.user.id);
    if (!garageId) return jsonResponse({ error: "Garage profile is not ready for billing yet." }, 403);
    if (!(await canUseVrmCheck(supabase, garageId))) {
      return jsonResponse({ error: VRM_CREDIT_MESSAGE }, 403);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to check VRM billing credits.";
    console.error("Unable to check VRM billing credits", message);
    return jsonResponse({ error: "Unable to check VRM billing credits." }, 500);
  }

  const cacheTtlDays = positiveInt(Deno.env.get("DVLA_CACHE_TTL_DAYS"), 30);
  const cacheCutoff = new Date(Date.now() - cacheTtlDays * 24 * 60 * 60 * 1000);
  const { data: cached } = await supabase
    .from("dvla_vehicle_cache")
    .select("payload, checked_at")
    .eq("registration", registrationNumber)
    .maybeSingle();

  if (cached?.payload && cached.checked_at && new Date(cached.checked_at) >= cacheCutoff) {
    const usageUpdated = await incrementVrmUsage(supabase, garageId);
    return jsonResponse({
      vehicle: cached.payload,
      source: "cache",
      usageUpdated,
    });
  }

  const dvlaResponse = await fetch(DVLA_ENDPOINT, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "x-api-key": dvlaApiKey,
    },
    body: JSON.stringify({ registrationNumber }),
  });
  const dvlaBody = await readJson(dvlaResponse);

  if (!dvlaResponse.ok) {
    return jsonResponse({
      error: mapDvlaError(dvlaResponse.status, dvlaBody),
      status: dvlaResponse.status,
    }, dvlaResponse.status);
  }

  const vehicle = mapDvlaVehicle(dvlaBody as Record<string, unknown>, registrationNumber);
  const { error: cacheError } = await supabase.from("dvla_vehicle_cache").upsert({
    registration: vehicle.registrationNumber || registrationNumber,
    payload: vehicle,
    raw_payload: dvlaBody,
    checked_at: new Date().toISOString(),
  });
  if (cacheError) {
    console.warn("Failed to cache DVLA response", cacheError.message);
  }

  const usageUpdated = await incrementVrmUsage(supabase, garageId);
  return jsonResponse({
    vehicle,
    source: "dvla",
    usageUpdated,
  });
});
