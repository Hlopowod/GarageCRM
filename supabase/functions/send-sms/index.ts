import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SMS_CREDIT_MESSAGE = "SMS is not available on your current plan or monthly SMS credits are used up.";

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizePhone(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let phone = raw.replace(/[^\d+]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  if (phone.startsWith("0")) phone = `+44${phone.slice(1)}`;
  if (phone && !phone.startsWith("+") && phone.length >= 10) phone = `+${phone}`;
  return phone;
}

async function recordSmsLog(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  payload: Record<string, unknown>,
  to: string,
  body: string,
  status: "sent" | "failed" | "pending" | "queued",
  providerMessageId = "",
  errorMessage = "",
) {
  const sentAt = status === "failed" ? null : new Date().toISOString();
  const { error } = await supabase.from("sms_logs").insert({
    user_id: userId,
    customer_id: payload.customerId ?? null,
    vehicle_id: payload.vehicleId ?? null,
    booking_id: payload.bookingId ?? null,
    job_card_id: payload.jobCardId ?? null,
    reminder_type: payload.reminderType || null,
    phone_number: to,
    message_body: body,
    status,
    provider: "twilio",
    provider_message_id: providerMessageId || null,
    error_message: errorMessage || null,
    sent_at: sentAt,
  });
  if (error) console.error("Unable to record SMS log", error.message);

  const reminderType = String(payload.reminderType || "");
  const reminderStage = String(payload.reminderStage || "");
  const dueDate = String(payload.scheduledFor || "");
  if ((reminderType === "MOT" || reminderType === "SERVICE") && reminderStage && dueDate) {
    const { error: historyError } = await supabase.from("sms_reminder_history").upsert({
      user_id: userId,
      vehicle_id: payload.vehicleId ?? null,
      customer_id: payload.customerId ?? null,
      reminder_type: reminderType,
      due_date: dueDate,
      reminder_stage: reminderStage,
      sent_at: sentAt,
      status,
    }, {
      onConflict: "user_id,vehicle_id,customer_id,reminder_type,due_date,reminder_stage",
    });
    if (historyError) console.error("Unable to record SMS reminder history", historyError.message);
  }
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

async function canUseSmsCredit(
  supabase: ReturnType<typeof createClient>,
  garageId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("can_send_sms", { p_garage_id: garageId });
  if (error) throw new Error(error.message);
  return Boolean(data);
}

async function incrementSmsUsage(
  supabase: ReturnType<typeof createClient>,
  garageId: string,
): Promise<boolean> {
  const { error } = await supabase.rpc("increment_sms_usage", { p_garage_id: garageId });
  if (error) {
    console.error("Unable to increment SMS usage", error.message);
    return false;
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ message: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
  const twilioToken = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
  const twilioFrom = normalizePhone(Deno.env.get("TWILIO_FROM_NUMBER"));

  if (!supabaseUrl || !serviceRoleKey || !twilioSid || !twilioToken || !twilioFrom) {
    return jsonResponse({ message: "SMS service is not configured yet." }, 500);
  }

  const authHeader = req.headers.get("Authorization") || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) return jsonResponse({ message: "Missing user access token." }, 401);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const { data: authData, error: authError } = await supabase.auth.getUser(accessToken);
  if (authError || !authData.user) {
    return jsonResponse({ message: "Invalid user session." }, 401);
  }

  const payload = await req.json().catch(() => ({}));
  const to = normalizePhone(payload.to);
  const body = String(payload.body || "").trim();

  if (!to) return jsonResponse({ message: "Recipient phone number is required." }, 400);
  if (!body) return jsonResponse({ message: "Message body is required." }, 400);
  if (body.length > 1600) return jsonResponse({ message: "Message body is too long." }, 400);

  let garageId = "";
  try {
    garageId = await getGarageIdForUser(supabase, authData.user.id);
    if (!garageId) return jsonResponse({ message: "Garage profile is not ready for billing yet." }, 403);
    if (!(await canUseSmsCredit(supabase, garageId))) {
      return jsonResponse({ message: SMS_CREDIT_MESSAGE }, 403);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to check SMS billing credits.";
    console.error("Unable to check SMS billing credits", message);
    return jsonResponse({ message: "Unable to check SMS billing credits." }, 500);
  }

  const form = new URLSearchParams();
  form.set("To", to);
  form.set("From", twilioFrom);
  form.set("Body", body);

  const twilioResponse = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${twilioSid}:${twilioToken}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    },
  );

  const twilioJson = await twilioResponse.json().catch(() => ({}));
  if (!twilioResponse.ok) {
    await recordSmsLog(
      supabase,
      authData.user.id,
      payload,
      to,
      body,
      "failed",
      "",
      twilioJson.message || "SMS service rejected the request.",
    );
    return jsonResponse({
      message: twilioJson.message || "SMS service rejected the request.",
      code: twilioJson.code || null,
    }, twilioResponse.status);
  }

  await recordSmsLog(
    supabase,
    authData.user.id,
    payload,
    to,
    body,
    String(twilioJson.status || "queued").toLowerCase() === "queued" ? "queued" : "sent",
    twilioJson.sid || "",
  );
  const usageUpdated = await incrementSmsUsage(supabase, garageId);

  return jsonResponse({
    sid: twilioJson.sid || "",
    status: twilioJson.status || "queued",
    usageUpdated,
  });
});
