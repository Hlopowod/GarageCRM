import { useAdminAuth } from '../hooks/useAdminAuth';
import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase';

export type AdminDailyCount = {
  date: string;
  count: number;
};

export type AdminMonthlyRevenue = {
  month: string;
  revenue: number;
};

export type AdminRoleCount = {
  role: string;
  count: number;
};

export type AdminRecentUser = {
  full_name: string | null;
  email: string | null;
  role: string;
  created_at: string;
};

export type AdminRecentBusiness = {
  business_name: string | null;
  owner_email: string | null;
  created_at: string;
  status: string | null;
};

export type AdminRecentPayment = {
  customer: string | null;
  plan: string | null;
  amount: number | null;
  status: string | null;
  created_at: string;
};

export type AdminDashboardStats = {
  totalUsers: number;
  usersToday: number;
  usersThisMonth: number;
  totalGarages: number;
  activeGarages: number;
  totalCustomers: number;
  totalVehicles: number;
  totalJobs: number;
  totalInvoices: number;
  monthlyRevenue: number;
  activeSubscriptions: number;
  newUsersByDay: AdminDailyCount[];
  jobsByDay: AdminDailyCount[];
  revenueByMonth: AdminMonthlyRevenue[];
  usersByRole: AdminRoleCount[];
  recentUsers: AdminRecentUser[];
  recentBusinesses: AdminRecentBusiness[];
  recentPayments: AdminRecentPayment[];
};

const EMPTY_STATS: AdminDashboardStats = Object.freeze({
  totalUsers: 0,
  usersToday: 0,
  usersThisMonth: 0,
  totalGarages: 0,
  activeGarages: 0,
  totalCustomers: 0,
  totalVehicles: 0,
  totalJobs: 0,
  totalInvoices: 0,
  monthlyRevenue: 0,
  activeSubscriptions: 0,
  newUsersByDay: [],
  jobsByDay: [],
  revenueByMonth: [],
  usersByRole: [],
  recentUsers: [],
  recentBusinesses: [],
  recentPayments: [],
});

function toNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeIsoDate(value: unknown): string {
  const raw = String(value || '');
  const match = raw.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : raw;
}

function normalizeDailyCount(row: any): AdminDailyCount {
  return {
    date: normalizeIsoDate(row?.date),
    count: toNumber(row?.count),
  };
}

function normalizeMonthlyRevenue(row: any): AdminMonthlyRevenue {
  return {
    month: String(row?.month || ''),
    revenue: toNumber(row?.revenue),
  };
}

function normalizeRoleCount(row: any): AdminRoleCount {
  return {
    role: String(row?.role || 'user'),
    count: toNumber(row?.count),
  };
}

function normalizeStats(value: any): AdminDashboardStats {
  const stats = value && typeof value === 'object' ? value : {};
  return {
    totalUsers: toNumber(stats.totalUsers),
    usersToday: toNumber(stats.usersToday),
    usersThisMonth: toNumber(stats.usersThisMonth),
    totalGarages: toNumber(stats.totalGarages),
    activeGarages: toNumber(stats.activeGarages),
    totalCustomers: toNumber(stats.totalCustomers),
    totalVehicles: toNumber(stats.totalVehicles),
    totalJobs: toNumber(stats.totalJobs),
    totalInvoices: toNumber(stats.totalInvoices),
    monthlyRevenue: toNumber(stats.monthlyRevenue),
    activeSubscriptions: toNumber(stats.activeSubscriptions),
    newUsersByDay: asArray<any>(stats.newUsersByDay).map(normalizeDailyCount),
    jobsByDay: asArray<any>(stats.jobsByDay).map(normalizeDailyCount),
    revenueByMonth: asArray<any>(stats.revenueByMonth).map(normalizeMonthlyRevenue),
    usersByRole: asArray<any>(stats.usersByRole).map(normalizeRoleCount),
    recentUsers: asArray<AdminRecentUser>(stats.recentUsers),
    recentBusinesses: asArray<AdminRecentBusiness>(stats.recentBusinesses),
    recentPayments: asArray<AdminRecentPayment>(stats.recentPayments),
  };
}

export function getEmptyAdminDashboardStats(): AdminDashboardStats {
  return {
    ...EMPTY_STATS,
    newUsersByDay: [],
    jobsByDay: [],
    revenueByMonth: [],
    usersByRole: [],
    recentUsers: [],
    recentBusinesses: [],
    recentPayments: [],
  };
}

export async function fetchAdminDashboardStats(): Promise<AdminDashboardStats> {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured.');
  }

  const adminAuth = await useAdminAuth();
  if (!adminAuth.user) {
    throw new Error('Login required.');
  }
  if (!adminAuth.isAdmin) {
    throw new Error('Admin access required.');
  }

  const { data, error } = await getSupabaseClient().rpc('get_admin_dashboard_stats');
  if (error) throw error;

  return normalizeStats(data);
}
