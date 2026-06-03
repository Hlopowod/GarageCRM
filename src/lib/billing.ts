import { getSupabaseClient } from './supabase';
import { getSession } from './auth';

export type PlanKey = 'pit_stop' | 'service_bay' | 'full_workshop' | 'garage_empire';

export type PlanLimits = {
  plan: PlanKey;
  max_vehicle_records_per_month: number;
  max_bookings_per_month: number;
  max_customer_records: number;
  max_job_cards_per_month: number;
  max_sms_per_month: number;
  max_vrm_checks_per_month: number;
  max_users: number;
  can_send_sms: boolean;
  can_check_vrm: boolean;
  can_use_automations: boolean;
};

export type GarageBillingRow = {
  id: string;
  owner_user_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  postcode: string | null;
  country_code: string;
  plan: PlanKey;
  subscription_status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
};

export type UsageMonthlyRow = {
  id?: string;
  garage_id?: string;
  month: string;
  vehicle_records_used: number;
  sms_used: number;
  vrm_checks_used: number;
  extra_sms_credits: number;
  extra_vrm_credits: number;
};

export type BillingSnapshot = {
  garage: GarageBillingRow | null;
  limits: PlanLimits;
  limitsByPlan: Record<PlanKey, PlanLimits>;
  usage: UsageMonthlyRow;
  month: string;
  isAdminAccount: boolean;
};

export type CheckoutSessionResult = {
  url: string;
  sessionId: string;
};

const UNLIMITED_LIMIT = 2147483647;

const ADMIN_ACCOUNT_LIMITS: PlanLimits = Object.freeze({
  plan: 'garage_empire',
  max_vehicle_records_per_month: UNLIMITED_LIMIT,
  max_bookings_per_month: UNLIMITED_LIMIT,
  max_customer_records: UNLIMITED_LIMIT,
  max_job_cards_per_month: UNLIMITED_LIMIT,
  max_sms_per_month: UNLIMITED_LIMIT,
  max_vrm_checks_per_month: UNLIMITED_LIMIT,
  max_users: UNLIMITED_LIMIT,
  can_send_sms: true,
  can_check_vrm: true,
  can_use_automations: true,
});

const FALLBACK_PLAN_LIMITS: Record<PlanKey, PlanLimits> = Object.freeze({
  pit_stop: {
    plan: 'pit_stop',
    max_vehicle_records_per_month: 30,
    max_bookings_per_month: 30,
    max_customer_records: 30,
    max_job_cards_per_month: 30,
    max_sms_per_month: 0,
    max_vrm_checks_per_month: 0,
    max_users: 1,
    can_send_sms: false,
    can_check_vrm: false,
    can_use_automations: false,
  },
  service_bay: {
    plan: 'service_bay',
    max_vehicle_records_per_month: 100,
    max_bookings_per_month: 100,
    max_customer_records: 100,
    max_job_cards_per_month: 100,
    max_sms_per_month: 100,
    max_vrm_checks_per_month: 100,
    max_users: 1,
    can_send_sms: true,
    can_check_vrm: true,
    can_use_automations: true,
  },
  full_workshop: {
    plan: 'full_workshop',
    max_vehicle_records_per_month: 200,
    max_bookings_per_month: 200,
    max_customer_records: 200,
    max_job_cards_per_month: 200,
    max_sms_per_month: 250,
    max_vrm_checks_per_month: 200,
    max_users: 3,
    can_send_sms: true,
    can_check_vrm: true,
    can_use_automations: true,
  },
  garage_empire: {
    plan: 'garage_empire',
    max_vehicle_records_per_month: UNLIMITED_LIMIT,
    max_bookings_per_month: UNLIMITED_LIMIT,
    max_customer_records: UNLIMITED_LIMIT,
    max_job_cards_per_month: UNLIMITED_LIMIT,
    max_sms_per_month: 500,
    max_vrm_checks_per_month: 500,
    max_users: 5,
    can_send_sms: true,
    can_check_vrm: true,
    can_use_automations: true,
  },
});

let billingSnapshotCache: BillingSnapshot | null = null;
let billingSnapshotCachedAt = 0;

export function getCurrentMonthKey(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function getPlanLimits(
  plan: string = 'free',
  limitsByPlan: Partial<Record<PlanKey, PlanLimits>> = {}
): PlanLimits {
  const normalized = normalizePlan(plan);
  return limitsByPlan[normalized] || FALLBACK_PLAN_LIMITS[normalized];
}

export function canCreateVehicle(snapshot: BillingSnapshot | null | undefined): boolean {
  if (!snapshot) return true;
  return isUnlimitedLimit(snapshot.limits.max_vehicle_records_per_month)
    || Number(snapshot.usage.vehicle_records_used || 0) < Number(snapshot.limits.max_vehicle_records_per_month || 0);
}

export function canCreateBooking(snapshot: BillingSnapshot | null | undefined, bookingsThisMonth: number): boolean {
  if (!snapshot) return true;
  return isUnlimitedLimit(snapshot.limits.max_bookings_per_month)
    || Number(bookingsThisMonth || 0) < Number(snapshot.limits.max_bookings_per_month || 0);
}

export function canCreateCustomer(snapshot: BillingSnapshot | null | undefined, customerRecords: number): boolean {
  if (!snapshot) return true;
  return isUnlimitedLimit(snapshot.limits.max_customer_records)
    || Number(customerRecords || 0) < Number(snapshot.limits.max_customer_records || 0);
}

export function canCreateJobCard(snapshot: BillingSnapshot | null | undefined, jobCardsThisMonth: number): boolean {
  if (!snapshot) return true;
  return isUnlimitedLimit(snapshot.limits.max_job_cards_per_month)
    || Number(jobCardsThisMonth || 0) < Number(snapshot.limits.max_job_cards_per_month || 0);
}

export function canSendSms(snapshot: BillingSnapshot | null | undefined): boolean {
  if (!snapshot?.limits.can_send_sms) return false;
  const allowance = Number(snapshot.limits.max_sms_per_month || 0) + Number(snapshot.usage.extra_sms_credits || 0);
  return Number(snapshot.usage.sms_used || 0) < allowance;
}

export function canCheckVrm(snapshot: BillingSnapshot | null | undefined): boolean {
  if (!snapshot?.limits.can_check_vrm) return false;
  const allowance = Number(snapshot.limits.max_vrm_checks_per_month || 0) + Number(snapshot.usage.extra_vrm_credits || 0);
  return Number(snapshot.usage.vrm_checks_used || 0) < allowance;
}

export function invalidateBillingSnapshot(): void {
  billingSnapshotCache = null;
  billingSnapshotCachedAt = 0;
}

export async function loadBillingSnapshot({
  force = false,
  ensureGarage = true,
}: {
  force?: boolean;
  ensureGarage?: boolean;
} = {}): Promise<BillingSnapshot> {
  if (!force && billingSnapshotCache && Date.now() - billingSnapshotCachedAt < 15_000) {
    return billingSnapshotCache;
  }

  const client = getSupabaseClient();
  const session = await getSession();
  const user = session?.user;
  if (!user) throw new Error('Sign in before opening billing.');

  let garage = await fetchGarageForUser(user.id);
  if (!garage && ensureGarage) {
    garage = await createGarageForUser(user);
  }

  const { data: limitsRows, error: limitsError } = await client
    .from('plan_limits')
    .select('*');
  if (limitsError) throw new Error(limitsError.message);

  const limitsByPlan = { ...FALLBACK_PLAN_LIMITS };
  for (const row of limitsRows || []) {
    const plan = normalizePlan(row.plan);
    limitsByPlan[plan] = normalizePlanLimits(row);
  }

  const month = getCurrentMonthKey();
  let usage: UsageMonthlyRow | null = null;
  if (garage?.id) {
    const { data: usageRow, error: usageError } = await client
      .from('usage_monthly')
      .select('*')
      .eq('garage_id', garage.id)
      .eq('month', month)
      .maybeSingle();
    if (usageError) throw new Error(usageError.message);
    usage = usageRow as UsageMonthlyRow | null;
  }

  const isAdminAccount = await fetchIsCurrentUserAdminAccount();
  const snapshot: BillingSnapshot = {
    garage,
    limitsByPlan,
    limits: isAdminAccount ? ADMIN_ACCOUNT_LIMITS : getPlanLimits(garage?.plan || 'free', limitsByPlan),
    usage: normalizeUsage(usage, month),
    month,
    isAdminAccount,
  };
  billingSnapshotCache = snapshot;
  billingSnapshotCachedAt = Date.now();
  return snapshot;
}

async function fetchIsCurrentUserAdminAccount(): Promise<boolean> {
  const { data, error } = await getSupabaseClient().rpc('is_current_user_admin_account');
  if (error) {
    console.warn('Unable to check admin account override', error.message);
    return false;
  }
  return Boolean(data);
}

export async function createCheckoutSession(
  plan: Exclude<PlanKey, 'pit_stop'>,
  garageId: string,
  referralCode = '',
): Promise<CheckoutSessionResult> {
  const code = String(referralCode || '').trim().toUpperCase();
  const { data, error } = await getSupabaseClient().functions.invoke('create-checkout-session', {
    body: { plan, garage_id: garageId, referral_code: code || undefined },
  });
  if (error) throw new Error(await getFunctionErrorMessage(error, 'Unable to create checkout session.'));
  const url = String((data as Record<string, unknown>)?.url || '');
  if (!url) throw new Error('Checkout URL was not returned.');
  return {
    url,
    sessionId: String((data as Record<string, unknown>)?.session_id || ''),
  };
}

export async function createBillingPortalSession(garageId: string): Promise<string> {
  const { data, error } = await getSupabaseClient().functions.invoke('create-billing-portal-session', {
    body: { garage_id: garageId },
  });
  if (error) throw new Error(await getFunctionErrorMessage(error, 'Unable to create billing portal session.'));
  const url = String((data as Record<string, unknown>)?.url || '');
  if (!url) throw new Error('Billing portal URL was not returned.');
  return url;
}

export async function checkVehicleUsage(garageId: string): Promise<boolean> {
  const { data, error } = await getSupabaseClient().functions.invoke('vehicle-usage', {
    body: { action: 'can_create_vehicle', garage_id: garageId },
  });
  if (error) throw new Error(await getFunctionErrorMessage(error, 'Unable to check vehicle usage.'));
  return Boolean((data as Record<string, unknown>)?.allowed);
}

export async function incrementVehicleUsage(garageId: string): Promise<void> {
  const { error } = await getSupabaseClient().functions.invoke('vehicle-usage', {
    body: { action: 'increment_vehicle_usage', garage_id: garageId },
  });
  if (error) throw new Error(await getFunctionErrorMessage(error, 'Unable to increment vehicle usage.'));
  invalidateBillingSnapshot();
}

export async function syncCheckoutSession(garageId: string, sessionId: string): Promise<Record<string, unknown>> {
  const { data, error } = await getSupabaseClient().functions.invoke('sync-checkout-session', {
    body: { garage_id: garageId, session_id: sessionId },
  });
  if (error) throw new Error(await getFunctionErrorMessage(error, 'Unable to sync checkout session.'));
  invalidateBillingSnapshot();
  return (data || {}) as Record<string, unknown>;
}

export async function syncBillingStatus(garageId: string): Promise<Record<string, unknown>> {
  const { data, error } = await getSupabaseClient().functions.invoke('sync-billing-status', {
    body: { garage_id: garageId },
  });
  if (error) throw new Error(await getFunctionErrorMessage(error, 'Unable to sync billing status.'));
  invalidateBillingSnapshot();
  return (data || {}) as Record<string, unknown>;
}

async function getFunctionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const baseMessage = error instanceof Error ? error.message : String(error || '');
  const context = (error as { context?: Response })?.context;
  if (!context) return baseMessage || fallback;

  try {
    const contentType = context.headers?.get?.('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await context.json().catch(() => null) as Record<string, unknown> | null;
      const detail = String(body?.message || body?.error || body?.details || '').trim();
      if (detail) return detail;
    }

    const text = await context.text().catch(() => '');
    const detail = text.trim();
    if (detail) return detail;
  } catch {
    // Keep the original FunctionsHttpError message if the response body was already consumed.
  }

  return baseMessage || fallback;
}

async function fetchGarageForUser(userId: string): Promise<GarageBillingRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('garages')
    .select('*')
    .eq('owner_user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return normalizeGarageRow(data as GarageBillingRow | null);
}

async function createGarageForUser(user: { id: string; email?: string; user_metadata?: Record<string, unknown> }): Promise<GarageBillingRow> {
  const name = String(user.user_metadata?.garage_name || '').trim() || 'Garage CRM';
  const { data, error } = await getSupabaseClient()
    .from('garages')
    .insert({
      owner_user_id: user.id,
      email: user.email || null,
      name,
      country_code: 'GB',
    })
    .select('*')
    .single();
  if (error) {
    const existing = await fetchGarageForUser(user.id);
    if (existing) return existing;
    throw new Error(error.message);
  }
  return normalizeGarageRow(data as GarageBillingRow) as GarageBillingRow;
}

function normalizePlan(plan: string): PlanKey {
  const normalized = String(plan || '').toLowerCase();
  if (normalized === 'service_bay' || normalized === 'basic') return 'service_bay';
  if (normalized === 'full_workshop') return 'full_workshop';
  if (normalized === 'garage_empire' || normalized === 'ultimate') return 'garage_empire';
  return 'pit_stop';
}

function normalizeGarageRow(row: GarageBillingRow | null): GarageBillingRow | null {
  if (!row) return null;
  const plan = normalizePlan(String(row.plan || 'pit_stop'));
  return {
    ...row,
    plan: effectivePlanForGarage(plan, row.subscription_status, row.current_period_end),
  };
}

function effectivePlanForGarage(plan: PlanKey, status: string, currentPeriodEnd: string | null): PlanKey {
  if (plan === 'pit_stop') return 'pit_stop';
  const normalizedStatus = String(status || '').toLowerCase();
  if (normalizedStatus === 'active' || normalizedStatus === 'trialing') return plan;
  if (currentPeriodEnd && new Date(currentPeriodEnd).getTime() > Date.now()) return plan;
  return 'pit_stop';
}

function normalizePlanLimits(row: Record<string, unknown>): PlanLimits {
  const rawPlan = String(row.plan || 'free').toLowerCase();
  const plan = normalizePlan(rawPlan);
  const fallback = FALLBACK_PLAN_LIMITS[plan];
  if ((rawPlan === 'free' || rawPlan === 'basic' || rawPlan === 'ultimate') && row.max_bookings_per_month === undefined) {
    return fallback;
  }
  return {
    plan,
    max_vehicle_records_per_month: numberFromRow(row.max_vehicle_records_per_month, fallback.max_vehicle_records_per_month),
    max_bookings_per_month: numberFromRow(row.max_bookings_per_month, fallback.max_bookings_per_month),
    max_customer_records: numberFromRow(row.max_customer_records, fallback.max_customer_records),
    max_job_cards_per_month: numberFromRow(row.max_job_cards_per_month, fallback.max_job_cards_per_month),
    max_sms_per_month: numberFromRow(row.max_sms_per_month, fallback.max_sms_per_month),
    max_vrm_checks_per_month: numberFromRow(row.max_vrm_checks_per_month, fallback.max_vrm_checks_per_month),
    max_users: numberFromRow(row.max_users, fallback.max_users),
    can_send_sms: Boolean(row.can_send_sms),
    can_check_vrm: Boolean(row.can_check_vrm),
    can_use_automations: Boolean(row.can_use_automations),
  };
}

function numberFromRow(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isUnlimitedLimit(value: number): boolean {
  return Number(value || 0) >= 1_000_000;
}

function normalizeUsage(row: UsageMonthlyRow | null, month: string): UsageMonthlyRow {
  return {
    id: row?.id,
    garage_id: row?.garage_id,
    month,
    vehicle_records_used: Number(row?.vehicle_records_used || 0),
    sms_used: Number(row?.sms_used || 0),
    vrm_checks_used: Number(row?.vrm_checks_used || 0),
    extra_sms_credits: Number(row?.extra_sms_credits || 0),
    extra_vrm_credits: Number(row?.extra_vrm_credits || 0),
  };
}
