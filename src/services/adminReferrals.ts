import { useAdminAuth } from '../hooks/useAdminAuth';
import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase';

export type AdminReferralSummary = {
  totalCodes: number;
  activeCodes: number;
  attributedGarages: number;
  referralRevenueCents: number;
  pendingCommissionCents: number;
  paidCommissionCents: number;
};

export type AdminReferralCode = {
  id: string;
  code: string;
  referrer_name: string;
  referrer_email: string | null;
  commission_percent: number;
  payout_months: number;
  status: 'active' | 'paused';
  notes: string | null;
  created_at: string;
  attributed_garages: number;
  revenue_cents: number;
  pending_commission_cents: number;
  paid_commission_cents: number;
};

export type AdminReferralCommission = {
  id: string;
  code: string;
  referrer_name: string;
  customer: string;
  invoice_amount_cents: number;
  currency: string;
  commission_percent: number;
  commission_amount_cents: number;
  payout_month_index: number;
  status: 'pending' | 'approved' | 'paid' | 'void';
  invoice_created_at: string | null;
  created_at: string;
  paid_at: string | null;
  notes: string | null;
};

export type AdminReferralsDashboard = {
  summary: AdminReferralSummary;
  codes: AdminReferralCode[];
  recentCommissions: AdminReferralCommission[];
};

export type AdminReferralCodeInput = {
  code?: string;
  referrerName: string;
  referrerEmail?: string;
  commissionPercent: number;
  payoutMonths: number;
  status: 'active' | 'paused';
  notes?: string;
};

const EMPTY_REFERRALS: AdminReferralsDashboard = Object.freeze({
  summary: {
    totalCodes: 0,
    activeCodes: 0,
    attributedGarages: 0,
    referralRevenueCents: 0,
    pendingCommissionCents: 0,
    paidCommissionCents: 0,
  },
  codes: [],
  recentCommissions: [],
});

function toNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeSummary(value: any): AdminReferralSummary {
  const summary = value && typeof value === 'object' ? value : {};
  return {
    totalCodes: toNumber(summary.totalCodes),
    activeCodes: toNumber(summary.activeCodes),
    attributedGarages: toNumber(summary.attributedGarages),
    referralRevenueCents: toNumber(summary.referralRevenueCents),
    pendingCommissionCents: toNumber(summary.pendingCommissionCents),
    paidCommissionCents: toNumber(summary.paidCommissionCents),
  };
}

function normalizeCode(row: any): AdminReferralCode {
  return {
    id: String(row?.id || ''),
    code: String(row?.code || ''),
    referrer_name: String(row?.referrer_name || ''),
    referrer_email: row?.referrer_email ? String(row.referrer_email) : null,
    commission_percent: toNumber(row?.commission_percent),
    payout_months: toNumber(row?.payout_months),
    status: row?.status === 'paused' ? 'paused' : 'active',
    notes: row?.notes ? String(row.notes) : null,
    created_at: String(row?.created_at || ''),
    attributed_garages: toNumber(row?.attributed_garages),
    revenue_cents: toNumber(row?.revenue_cents),
    pending_commission_cents: toNumber(row?.pending_commission_cents),
    paid_commission_cents: toNumber(row?.paid_commission_cents),
  };
}

function normalizeCommission(row: any): AdminReferralCommission {
  const status = String(row?.status || 'pending');
  return {
    id: String(row?.id || ''),
    code: String(row?.code || ''),
    referrer_name: String(row?.referrer_name || ''),
    customer: String(row?.customer || 'Unknown customer'),
    invoice_amount_cents: toNumber(row?.invoice_amount_cents),
    currency: String(row?.currency || 'gbp'),
    commission_percent: toNumber(row?.commission_percent),
    commission_amount_cents: toNumber(row?.commission_amount_cents),
    payout_month_index: toNumber(row?.payout_month_index),
    status: status === 'approved' || status === 'paid' || status === 'void' ? status : 'pending',
    invoice_created_at: row?.invoice_created_at ? String(row.invoice_created_at) : null,
    created_at: String(row?.created_at || ''),
    paid_at: row?.paid_at ? String(row.paid_at) : null,
    notes: row?.notes ? String(row.notes) : null,
  };
}

function normalizeReferrals(value: any): AdminReferralsDashboard {
  const dashboard = value && typeof value === 'object' ? value : {};
  return {
    summary: normalizeSummary(dashboard.summary),
    codes: asArray<any>(dashboard.codes).map(normalizeCode),
    recentCommissions: asArray<any>(dashboard.recentCommissions).map(normalizeCommission),
  };
}

function rpcPayload(input: AdminReferralCodeInput): Record<string, unknown> {
  return {
    p_code: input.code || '',
    p_referrer_name: input.referrerName,
    p_referrer_email: input.referrerEmail || null,
    p_commission_percent: input.commissionPercent,
    p_payout_months: input.payoutMonths,
    p_status: input.status,
    p_notes: input.notes || null,
  };
}

async function ensureAdmin(): Promise<void> {
  if (!isSupabaseConfigured()) throw new Error('Supabase is not configured.');
  const adminAuth = await useAdminAuth();
  if (!adminAuth.user) throw new Error('Login required.');
  if (!adminAuth.isAdmin) throw new Error('Admin access required.');
}

export function getEmptyAdminReferrals(): AdminReferralsDashboard {
  return {
    summary: { ...EMPTY_REFERRALS.summary },
    codes: [],
    recentCommissions: [],
  };
}

export async function fetchAdminReferrals(): Promise<AdminReferralsDashboard> {
  await ensureAdmin();
  const { data, error } = await getSupabaseClient().rpc('get_admin_referrals');
  if (error) throw error;
  return normalizeReferrals(data);
}

export async function createAdminReferralCode(input: AdminReferralCodeInput): Promise<AdminReferralCode> {
  await ensureAdmin();
  const { data, error } = await getSupabaseClient().rpc('create_referral_code', rpcPayload(input));
  if (error) throw error;
  return normalizeCode(data);
}

export async function updateAdminReferralCode(id: string, input: AdminReferralCodeInput): Promise<AdminReferralCode> {
  await ensureAdmin();
  const payload = rpcPayload(input);
  delete payload.p_code;
  const { data, error } = await getSupabaseClient().rpc('update_referral_code', {
    p_id: id,
    ...payload,
  });
  if (error) throw error;
  return normalizeCode(data);
}

export async function markAdminReferralCommissionPaid(id: string, notes = ''): Promise<AdminReferralCommission> {
  await ensureAdmin();
  const { data, error } = await getSupabaseClient().rpc('mark_referral_commission_paid', {
    p_commission_id: id,
    p_notes: notes || null,
  });
  if (error) throw error;
  return normalizeCommission(data);
}
