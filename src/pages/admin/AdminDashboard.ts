import type { AdminProfile } from '../../hooks/useAdminAuth';
import type { AdminDashboardStats } from '../../services/adminStats';
import type { AdminReferralCode, AdminReferralsDashboard } from '../../services/adminReferrals';
import {
  type AdminSectionKey,
  ADMIN_NAV_ITEMS,
  escapeAdminHtml,
  formatAdminDate,
  formatAdminMoney,
  formatAdminNumber,
  renderAdminEmptyState,
  renderAdminError,
  renderAdminLayout,
  renderAdminLoading,
  renderAdminStatGrid,
  renderDailyBarChart,
  renderDailyCountChart,
  renderRecentBusinessesTable,
  renderRecentPaymentsTable,
  renderRecentUsersTable,
  renderRevenueChart,
  renderRoleChart,
} from '../../components/admin/AdminUi';

type RenderAdminDashboardPageOptions = {
  section: string;
  stats: AdminDashboardStats | null;
  referrals: AdminReferralsDashboard | null;
  loading: boolean;
  error: string;
  referralsLoading: boolean;
  referralsError: string;
  referralSaving: boolean;
  referralEditId: string;
  profile: AdminProfile | null;
};

const ADMIN_SECTION_KEYS = new Set(ADMIN_NAV_ITEMS.map(item => item.key));

export function normalizeAdminSection(section: string): AdminSectionKey {
  const key = String(section || '').trim().toLowerCase() as AdminSectionKey;
  return ADMIN_SECTION_KEYS.has(key) ? key : 'dashboard';
}

function renderOverview(stats: AdminDashboardStats): string {
  const cards = [
    { label: 'Total users', value: formatAdminNumber(stats.totalUsers), hint: 'All registered accounts', tone: 'blue' as const },
    { label: 'New users today', value: formatAdminNumber(stats.usersToday), hint: 'Created today', tone: 'green' as const },
    { label: 'New users this month', value: formatAdminNumber(stats.usersThisMonth), hint: 'Month to date', tone: 'green' as const },
    { label: 'Active garages', value: formatAdminNumber(stats.activeGarages), hint: `${formatAdminNumber(stats.totalGarages)} total businesses`, tone: 'blue' as const },
    { label: 'Total customers', value: formatAdminNumber(stats.totalCustomers), hint: 'Across synced snapshots', tone: 'gray' as const },
    { label: 'Total vehicles', value: formatAdminNumber(stats.totalVehicles), hint: 'Across synced snapshots', tone: 'gray' as const },
    { label: 'Total jobs', value: formatAdminNumber(stats.totalJobs), hint: 'All job cards', tone: 'amber' as const },
    { label: 'Total invoices', value: formatAdminNumber(stats.totalInvoices), hint: 'All invoices', tone: 'amber' as const },
    { label: 'Monthly revenue', value: formatAdminMoney(stats.monthlyRevenue), hint: 'From paid invoice data', tone: 'green' as const },
    { label: 'Active subscriptions', value: formatAdminNumber(stats.activeSubscriptions), hint: 'Paid active or trialing plans', tone: 'blue' as const },
  ];

  return `
    ${renderAdminStatGrid(cards)}
    <div class="admin-chart-grid admin-chart-grid-primary">
      ${renderDailyCountChart('New users by day', stats.newUsersByDay)}
      ${renderDailyBarChart('Jobs created by day', stats.jobsByDay)}
      ${renderRevenueChart('Revenue by month', stats.revenueByMonth)}
      ${renderRoleChart(stats.usersByRole)}
    </div>
    <div class="admin-table-grid">
      ${renderRecentUsersTable(stats.recentUsers)}
      ${renderRecentBusinessesTable(stats.recentBusinesses)}
      ${renderRecentPaymentsTable(stats.recentPayments)}
    </div>
  `;
}

function renderUsers(stats: AdminDashboardStats): string {
  return `
    ${renderAdminStatGrid([
      { label: 'Total users', value: formatAdminNumber(stats.totalUsers), hint: 'All accounts', tone: 'blue' },
      { label: 'New today', value: formatAdminNumber(stats.usersToday), hint: 'Created today', tone: 'green' },
      { label: 'New this month', value: formatAdminNumber(stats.usersThisMonth), hint: 'Month to date', tone: 'green' },
    ])}
    <div class="admin-chart-grid admin-chart-grid-compact">
      ${renderDailyCountChart('New users by day', stats.newUsersByDay)}
      ${renderRoleChart(stats.usersByRole)}
    </div>
    ${renderRecentUsersTable(stats.recentUsers)}
  `;
}

function renderBusinesses(stats: AdminDashboardStats): string {
  return `
    ${renderAdminStatGrid([
      { label: 'Total businesses', value: formatAdminNumber(stats.totalGarages), hint: 'Garage profiles', tone: 'blue' },
      { label: 'Active businesses', value: formatAdminNumber(stats.activeGarages), hint: 'Active or trialing', tone: 'green' },
      { label: 'Customers', value: formatAdminNumber(stats.totalCustomers), hint: 'Across businesses', tone: 'gray' },
      { label: 'Vehicles', value: formatAdminNumber(stats.totalVehicles), hint: 'Across businesses', tone: 'gray' },
    ])}
    ${renderRecentBusinessesTable(stats.recentBusinesses)}
  `;
}

function renderPayments(stats: AdminDashboardStats): string {
  return `
    ${renderAdminStatGrid([
      { label: 'Monthly revenue', value: formatAdminMoney(stats.monthlyRevenue), hint: 'From paid invoice data', tone: 'green' },
      { label: 'Active subscriptions', value: formatAdminNumber(stats.activeSubscriptions), hint: 'Paid active or trialing plans', tone: 'blue' },
      { label: 'Total invoices', value: formatAdminNumber(stats.totalInvoices), hint: 'All invoices', tone: 'amber' },
    ])}
    <div class="admin-chart-grid admin-chart-grid-compact">
      ${renderRevenueChart('Revenue by month', stats.revenueByMonth)}
    </div>
    ${renderRecentPaymentsTable(stats.recentPayments)}
  `;
}

function formatAdminCents(value: unknown): string {
  return formatAdminMoney(Number(value || 0) / 100);
}

function renderReferralStatus(status: string): string {
  const normalized = ['active', 'paused', 'pending', 'approved', 'paid', 'void'].includes(status) ? status : 'active';
  return `<span class="admin-pill admin-pill-${escapeAdminHtml(normalized)}">${escapeAdminHtml(normalized)}</span>`;
}

function getReferralFormCode(referrals: AdminReferralsDashboard | null, editId: string): AdminReferralCode | null {
  if (!editId) return null;
  return referrals?.codes.find(code => code.id === editId) || null;
}

function renderReferralCodeForm(referrals: AdminReferralsDashboard | null, editId: string, saving: boolean): string {
  const editing = getReferralFormCode(referrals, editId);
  const isEditing = Boolean(editing);

  return `
    <section class="admin-panel admin-referral-form-panel">
      <div class="admin-panel-header">
        <h2>${isEditing ? 'Edit referral code' : 'New referral code'}</h2>
      </div>
      <div class="admin-referral-form">
        <label>
          <span>Code</span>
          <input id="admin-referral-code" type="text" maxlength="32" value="${escapeAdminHtml(editing?.code || '')}" ${isEditing ? 'disabled' : ''} placeholder="GARAGE20" />
        </label>
        <label>
          <span>Referrer name</span>
          <input id="admin-referral-name" type="text" maxlength="120" value="${escapeAdminHtml(editing?.referrer_name || '')}" />
        </label>
        <label>
          <span>Email</span>
          <input id="admin-referral-email" type="email" maxlength="180" value="${escapeAdminHtml(editing?.referrer_email || '')}" />
        </label>
        <div class="admin-referral-form-row">
          <label>
            <span>Commission</span>
            <input id="admin-referral-percent" type="number" min="0" max="100" step="0.5" value="${escapeAdminHtml(editing?.commission_percent ?? 20)}" />
          </label>
          <label>
            <span>Months</span>
            <input id="admin-referral-months" type="number" min="1" max="36" step="1" value="${escapeAdminHtml(editing?.payout_months ?? 3)}" />
          </label>
          <label>
            <span>Status</span>
            <select id="admin-referral-status">
              <option value="active" ${editing?.status === 'paused' ? '' : 'selected'}>Active</option>
              <option value="paused" ${editing?.status === 'paused' ? 'selected' : ''}>Paused</option>
            </select>
          </label>
        </div>
        <label>
          <span>Notes</span>
          <textarea id="admin-referral-notes" rows="3">${escapeAdminHtml(editing?.notes || '')}</textarea>
        </label>
        <div class="admin-referral-actions">
          <button class="btn btn-primary" type="button" onclick="saveAdminReferralCode()" ${saving ? 'disabled' : ''}>${saving ? 'Saving...' : isEditing ? 'Save changes' : 'Create code'}</button>
          ${isEditing ? '<button class="btn" type="button" onclick="cancelAdminReferralEdit()">Cancel</button>' : ''}
        </div>
      </div>
    </section>
  `;
}

function renderReferralCodesTable(codes: AdminReferralCode[]): string {
  return `
    <section class="admin-panel">
      <div class="admin-panel-header">
        <h2>Referral codes</h2>
      </div>
      ${codes.length ? `
        <div class="admin-table-wrap">
          <table class="admin-table admin-referral-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Referrer</th>
                <th>Commission</th>
                <th>Months</th>
                <th>Garages</th>
                <th>Revenue</th>
                <th>Due</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${codes.map(code => `
                <tr>
                  <td><strong class="admin-referral-code">${escapeAdminHtml(code.code)}</strong></td>
                  <td>
                    <div class="admin-referral-person">
                      <strong>${escapeAdminHtml(code.referrer_name || '-')}</strong>
                      <span>${escapeAdminHtml(code.referrer_email || '')}</span>
                    </div>
                  </td>
                  <td>${escapeAdminHtml(`${formatAdminNumber(code.commission_percent)}%`)}</td>
                  <td>${escapeAdminHtml(formatAdminNumber(code.payout_months))}</td>
                  <td>${escapeAdminHtml(formatAdminNumber(code.attributed_garages))}</td>
                  <td>${escapeAdminHtml(formatAdminCents(code.revenue_cents))}</td>
                  <td>${escapeAdminHtml(formatAdminCents(code.pending_commission_cents))}</td>
                  <td>${renderReferralStatus(code.status)}</td>
                  <td><button class="btn btn-sm" type="button" onclick="editAdminReferralCode('${escapeAdminHtml(code.id)}')">Edit</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : renderAdminEmptyState('No referral codes yet')}
    </section>
  `;
}

function renderReferralCommissionsTable(referrals: AdminReferralsDashboard): string {
  const rows = referrals.recentCommissions;
  return `
    <section class="admin-panel">
      <div class="admin-panel-header">
        <h2>Commission ledger</h2>
      </div>
      ${rows.length ? `
        <div class="admin-table-wrap">
          <table class="admin-table admin-referral-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Customer</th>
                <th>Invoice</th>
                <th>Commission</th>
                <th>Month</th>
                <th>Status</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(row => `
                <tr>
                  <td><strong class="admin-referral-code">${escapeAdminHtml(row.code)}</strong></td>
                  <td>${escapeAdminHtml(row.customer || '-')}</td>
                  <td>${escapeAdminHtml(formatAdminCents(row.invoice_amount_cents))}</td>
                  <td>
                    <div class="admin-referral-person">
                      <strong>${escapeAdminHtml(formatAdminCents(row.commission_amount_cents))}</strong>
                      <span>${escapeAdminHtml(`${formatAdminNumber(row.commission_percent)}%`)}</span>
                    </div>
                  </td>
                  <td>${escapeAdminHtml(formatAdminNumber(row.payout_month_index))}</td>
                  <td>${renderReferralStatus(row.status)}</td>
                  <td>${escapeAdminHtml(formatAdminDate(row.invoice_created_at || row.created_at))}</td>
                  <td>
                    ${row.status === 'paid' || row.status === 'void'
                      ? ''
                      : `<button class="btn btn-sm" type="button" onclick="markAdminReferralCommissionPaid('${escapeAdminHtml(row.id)}')">Mark paid</button>`}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : renderAdminEmptyState('No referral commissions yet')}
    </section>
  `;
}

function renderReferrals(
  referrals: AdminReferralsDashboard | null,
  loading: boolean,
  error: string,
  editId: string,
  saving: boolean,
): string {
  if (loading && !referrals) return renderAdminLoading();
  if (error && !referrals) return renderAdminError(error);

  const data = referrals || {
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
  };

  return `
    ${error ? `<div class="admin-alert admin-alert-error"><strong>Unable to update referrals</strong><span>${escapeAdminHtml(error)}</span></div>` : ''}
    ${renderAdminStatGrid([
      { label: 'Active codes', value: formatAdminNumber(data.summary.activeCodes), hint: `${formatAdminNumber(data.summary.totalCodes)} total`, tone: 'blue' },
      { label: 'Referral garages', value: formatAdminNumber(data.summary.attributedGarages), hint: 'Converted through codes', tone: 'green' },
      { label: 'Referral revenue', value: formatAdminCents(data.summary.referralRevenueCents), hint: 'Tracked paid invoices', tone: 'green' },
      { label: 'Commission due', value: formatAdminCents(data.summary.pendingCommissionCents), hint: 'Pending or approved', tone: 'amber' },
      { label: 'Commission paid', value: formatAdminCents(data.summary.paidCommissionCents), hint: 'Marked as paid', tone: 'gray' },
    ])}
    <div class="admin-referral-grid">
      ${renderReferralCodeForm(data, editId, saving)}
      ${renderReferralCodesTable(data.codes)}
    </div>
    ${renderReferralCommissionsTable(data)}
  `;
}

function renderSettings(profile: AdminProfile | null): string {
  return `
    <section class="admin-panel">
      <div class="admin-panel-header">
        <h2>Admin settings</h2>
      </div>
      <div class="admin-settings-list">
        <div>
          <span>Signed in as</span>
          <strong>${escapeAdminHtml(profile?.email || '-')}</strong>
        </div>
        <div>
          <span>Role source</span>
          <strong>profiles.role</strong>
        </div>
        <div>
          <span>Current role</span>
          <strong>${escapeAdminHtml(profile?.role || 'user')}</strong>
        </div>
      </div>
    </section>
  `;
}

function renderBody(section: AdminSectionKey, options: RenderAdminDashboardPageOptions): string {
  const stats = options.stats as AdminDashboardStats;
  if (section === 'users') return renderUsers(stats);
  if (section === 'businesses') return renderBusinesses(stats);
  if (section === 'payments') return renderPayments(stats);
  if (section === 'referrals') return renderReferrals(
    options.referrals,
    options.referralsLoading,
    options.referralsError,
    options.referralEditId,
    options.referralSaving,
  );
  if (section === 'settings') return renderSettings(options.profile);
  return renderOverview(stats);
}

export function renderAdminDashboardPage(options: RenderAdminDashboardPageOptions): string {
  const section = normalizeAdminSection(options.section);

  if (options.loading) {
    return renderAdminLayout({
      activeSection: section,
      profile: options.profile,
      body: renderAdminLoading(),
    });
  }

  if (options.error) {
    return renderAdminLayout({
      activeSection: section,
      profile: options.profile,
      body: renderAdminError(options.error),
    });
  }

  if (!options.stats) {
    return renderAdminLayout({
      activeSection: section,
      profile: options.profile,
      body: renderAdminEmptyState('No admin statistics loaded yet', 'Use Refresh to load dashboard data.'),
    });
  }

  return renderAdminLayout({
    activeSection: section,
    profile: options.profile,
    body: renderBody(section, options),
  });
}
