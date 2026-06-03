import type {
  AdminDailyCount,
  AdminMonthlyRevenue,
  AdminRecentBusiness,
  AdminRecentPayment,
  AdminRecentUser,
  AdminRoleCount,
} from '../../services/adminStats';
import type { AdminProfile } from '../../hooks/useAdminAuth';

export type AdminSectionKey = 'dashboard' | 'users' | 'businesses' | 'payments' | 'referrals' | 'settings';

export type AdminNavItem = {
  key: AdminSectionKey;
  label: string;
};

export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'users', label: 'Users' },
  { key: 'businesses', label: 'Businesses' },
  { key: 'payments', label: 'Payments' },
  { key: 'referrals', label: 'Referrals' },
  { key: 'settings', label: 'Settings' },
];

type AdminStatCard = {
  label: string;
  value: string;
  hint: string;
  tone?: 'blue' | 'green' | 'amber' | 'red' | 'gray';
};

type AdminTableColumn<T> = {
  label: string;
  render: (row: T) => string;
};

export function escapeAdminHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatAdminNumber(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return new Intl.NumberFormat('en-GB').format(number);
}

export function formatAdminMoney(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return '£0.00';
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
  }).format(number);
}

export function formatAdminDate(value: unknown): string {
  const raw = String(value || '');
  if (!raw) return '-';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw.slice(0, 10) || '-';
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function getIsoDate(value: string): string {
  const match = String(value || '').match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : String(value || '');
}

function formatShortDate(value: string): string {
  const iso = getIsoDate(value);
  if (!iso) return '';
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function formatMonthLabel(value: string): string {
  const match = String(value || '').match(/^(\d{4})-(\d{2})/);
  if (!match) return String(value || '');
  const date = new Date(`${match[1]}-${match[2]}-01T00:00:00Z`);
  return date.toLocaleDateString('en-GB', { month: 'short' });
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat('en-GB', {
    notation: Math.abs(value) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value);
}

function formatCompactMoney(value: number): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    notation: Math.abs(value) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(value) >= 1000 ? 1 : 0,
  }).format(value);
}

function getNiceMax(maxValue: number): number {
  const max = Math.max(1, maxValue);
  const power = Math.pow(10, Math.floor(Math.log10(max)));
  const scaled = max / power;
  if (scaled <= 2) return 2 * power;
  if (scaled <= 5) return 5 * power;
  return 10 * power;
}

function renderChartEmpty(): string {
  return `
    <div class="admin-chart-empty">
      <strong>No activity yet</strong>
    </div>
  `;
}

export function renderAdminLayout({
  activeSection,
  profile,
  body,
}: {
  activeSection: AdminSectionKey;
  profile: AdminProfile | null;
  body: string;
}): string {
  const adminName = profile?.full_name || profile?.email || 'Admin account';

  return `
    <div class="admin-shell">
      <div class="admin-header">
        <div>
          <h1>Admin Dashboard</h1>
          <div class="admin-header-subtitle">${escapeAdminHtml(adminName)}</div>
        </div>
        <button class="btn" type="button" onclick="refreshAdminDashboard()">Refresh</button>
      </div>

      <div class="admin-layout">
        <aside class="admin-side-nav" aria-label="Admin sections">
          ${ADMIN_NAV_ITEMS.map(item => `
            <button
              class="admin-side-nav-item ${item.key === activeSection ? 'active' : ''}"
              type="button"
              onclick="setAdminSection('${item.key}')"
            >
              ${escapeAdminHtml(item.label)}
            </button>
          `).join('')}
        </aside>
        <div class="admin-main-panel">
          ${body}
        </div>
      </div>
    </div>
  `;
}

export function renderAdminLoading(): string {
  return `
    <div class="admin-panel">
      <div class="admin-loading-grid">
        ${Array.from({ length: 6 }).map(() => '<div class="admin-skeleton"></div>').join('')}
      </div>
    </div>
  `;
}

export function renderAdminError(message: string): string {
  return `
    <div class="admin-alert admin-alert-error">
      <strong>Unable to load admin statistics</strong>
      <span>${escapeAdminHtml(message || 'Try refreshing the page.')}</span>
    </div>
  `;
}

export function renderAdminEmptyState(title: string, description = ''): string {
  return `
    <div class="admin-empty">
      <strong>${escapeAdminHtml(title)}</strong>
      ${description ? `<span>${escapeAdminHtml(description)}</span>` : ''}
    </div>
  `;
}

export function renderAdminStatGrid(cards: AdminStatCard[]): string {
  return `
    <div class="admin-stat-grid">
      ${cards.map(card => `
        <div class="admin-stat-card admin-stat-card-${card.tone || 'blue'}">
          <span class="admin-stat-label">${escapeAdminHtml(card.label)}</span>
          <strong>${escapeAdminHtml(card.value)}</strong>
          <span class="admin-stat-hint">${escapeAdminHtml(card.hint)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

type AdminChartPoint = {
  label: string;
  value: number;
};

function getChartLabels(points: AdminChartPoint[]): AdminChartPoint[] {
  if (points.length <= 3) return points;
  return [
    points[0],
    points[Math.floor(points.length / 2)],
    points[points.length - 1],
  ];
}

function renderLineSvg(points: AdminChartPoint[], valueFormatter: (value: number) => string): string {
  if (!points.length) return renderChartEmpty();

  const width = 720;
  const height = 276;
  const left = 46;
  const right = 18;
  const top = 18;
  const bottom = 38;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const max = getNiceMax(Math.max(...points.map(point => point.value)));
  const chartPoints = points.map((point, index) => {
    const x = left + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
    const y = top + plotHeight - (point.value / max) * plotHeight;
    return { ...point, x, y };
  });
  const linePath = chartPoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  const areaPath = chartPoints.length
    ? `${linePath} L ${chartPoints[chartPoints.length - 1].x.toFixed(2)} ${top + plotHeight} L ${chartPoints[0].x.toFixed(2)} ${top + plotHeight} Z`
    : '';
  const ticks = [max, max / 2, 0];
  const xLabels = getChartLabels(points);

  return `
    <svg class="admin-svg-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Chart">
      ${ticks.map(tick => {
        const y = top + plotHeight - (tick / max) * plotHeight;
        return `
          <line class="admin-chart-gridline" x1="${left}" y1="${y.toFixed(2)}" x2="${width - right}" y2="${y.toFixed(2)}"></line>
          <text class="admin-chart-axis" x="${left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end">${escapeAdminHtml(formatCompactNumber(tick))}</text>
        `;
      }).join('')}
      <path class="admin-chart-area" d="${areaPath}"></path>
      <path class="admin-chart-line" d="${linePath}"></path>
      ${chartPoints.filter(point => point.value > 0).map(point => `
        <circle class="admin-chart-point" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="4">
          <title>${escapeAdminHtml(`${point.label}: ${valueFormatter(point.value)}`)}</title>
        </circle>
      `).join('')}
      ${xLabels.map(labelPoint => {
        const index = points.indexOf(labelPoint);
        const x = left + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
        return `<text class="admin-chart-axis" x="${x.toFixed(2)}" y="${height - 10}" text-anchor="middle">${escapeAdminHtml(labelPoint.label)}</text>`;
      }).join('')}
    </svg>
  `;
}

function renderBarSvg(points: AdminChartPoint[], valueFormatter: (value: number) => string): string {
  if (!points.length) return renderChartEmpty();

  const width = 720;
  const height = 276;
  const left = 46;
  const right = 18;
  const top = 18;
  const bottom = 38;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const max = getNiceMax(Math.max(...points.map(point => point.value)));
  const step = plotWidth / points.length;
  const barWidth = Math.max(4, Math.min(26, step * 0.62));
  const ticks = [max, max / 2, 0];
  const labelIndexes = new Set(points.length <= 8
    ? points.map((_, index) => index)
    : [0, Math.floor(points.length / 2), points.length - 1]);

  return `
    <svg class="admin-svg-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Chart">
      ${ticks.map(tick => {
        const y = top + plotHeight - (tick / max) * plotHeight;
        return `
          <line class="admin-chart-gridline" x1="${left}" y1="${y.toFixed(2)}" x2="${width - right}" y2="${y.toFixed(2)}"></line>
          <text class="admin-chart-axis" x="${left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end">${escapeAdminHtml(formatCompactNumber(tick))}</text>
        `;
      }).join('')}
      ${points.map((point, index) => {
        const valueHeight = (point.value / max) * plotHeight;
        const x = left + index * step + (step - barWidth) / 2;
        const y = top + plotHeight - valueHeight;
        return `
          <rect class="admin-chart-bar-rect" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${Math.max(2, valueHeight).toFixed(2)}" rx="4">
            <title>${escapeAdminHtml(`${point.label}: ${valueFormatter(point.value)}`)}</title>
          </rect>
          ${labelIndexes.has(index) ? `<text class="admin-chart-axis" x="${(x + barWidth / 2).toFixed(2)}" y="${height - 10}" text-anchor="middle">${escapeAdminHtml(point.label)}</text>` : ''}
        `;
      }).join('')}
    </svg>
  `;
}

function renderChartPanel({
  title,
  total,
  body,
}: {
  title: string;
  total: string;
  body: string;
}): string {
  return `
    <section class="admin-panel admin-chart-panel">
      <div class="admin-panel-header">
        <h2>${escapeAdminHtml(title)}</h2>
        <strong class="admin-chart-total">${escapeAdminHtml(total)}</strong>
      </div>
      ${body}
    </section>
  `;
}

export function renderDailyCountChart(title: string, rows: AdminDailyCount[]): string {
  const points = rows.slice(-30).map(row => ({
    label: formatShortDate(row.date),
    value: Number(row.count || 0),
  }));
  const total = points.reduce((sum, point) => sum + point.value, 0);
  return renderChartPanel({
    title,
    total: `${formatAdminNumber(total)} total`,
    body: renderLineSvg(points, formatAdminNumber),
  });
}

export function renderDailyBarChart(title: string, rows: AdminDailyCount[]): string {
  const points = rows.slice(-30).map(row => ({
    label: formatShortDate(row.date),
    value: Number(row.count || 0),
  }));
  const total = points.reduce((sum, point) => sum + point.value, 0);
  return renderChartPanel({
    title,
    total: `${formatAdminNumber(total)} total`,
    body: renderBarSvg(points, formatAdminNumber),
  });
}

export function renderRevenueChart(title: string, rows: AdminMonthlyRevenue[]): string {
  const points = rows.map(row => ({
    label: formatMonthLabel(row.month),
    value: Number(row.revenue || 0),
  }));
  const total = points.reduce((sum, point) => sum + point.value, 0);
  return renderChartPanel({
    title,
    total: formatAdminMoney(total),
    body: renderBarSvg(points, formatCompactMoney),
  });
}

export function renderRoleChart(rows: AdminRoleCount[]): string {
  const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  if (!rows.length || total <= 0) {
    return renderChartPanel({
      title: 'Users by role',
      total: '0 users',
      body: renderChartEmpty(),
    });
  }

  const colors = ['#1d5fbf', '#16a34a', '#f59e0b', '#6b7280'];
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const segments = rows.map((row, index) => {
    const value = Number(row.count || 0);
    const length = (value / total) * circumference;
    const segment = {
      row,
      color: colors[index % colors.length],
      dasharray: `${length.toFixed(2)} ${(circumference - length).toFixed(2)}`,
      dashoffset: (-offset).toFixed(2),
    };
    offset += length;
    return segment;
  });

  return `
    <section class="admin-panel admin-role-panel">
      <div class="admin-panel-header">
        <h2>Users by role</h2>
        <strong class="admin-chart-total">${escapeAdminHtml(`${formatAdminNumber(total)} users`)}</strong>
      </div>
      <div class="admin-role-chart">
        <svg class="admin-donut-chart" viewBox="0 0 150 150" role="img" aria-label="Users by role">
          <circle class="admin-donut-track" cx="75" cy="75" r="${radius}"></circle>
          ${segments.map(segment => `
            <circle
              class="admin-donut-segment"
              cx="75"
              cy="75"
              r="${radius}"
              stroke="${segment.color}"
              stroke-dasharray="${segment.dasharray}"
              stroke-dashoffset="${segment.dashoffset}"
            ></circle>
          `).join('')}
          <text class="admin-donut-total" x="75" y="72" text-anchor="middle">${escapeAdminHtml(formatAdminNumber(total))}</text>
          <text class="admin-donut-caption" x="75" y="92" text-anchor="middle">users</text>
        </svg>
        <div class="admin-role-legend">
          ${segments.map(segment => {
            const value = Number(segment.row.count || 0);
            const pct = total ? Math.round((value / total) * 100) : 0;
            return `
              <div class="admin-role-legend-row">
                <span class="admin-role-dot" style="background:${segment.color}"></span>
                <span>${escapeAdminHtml(segment.row.role || 'user')}</span>
                <strong>${escapeAdminHtml(`${formatAdminNumber(value)} (${pct}%)`)}</strong>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </section>
  `;
}

export function renderAdminTable<T>({
  title,
  columns,
  rows,
  emptyTitle,
}: {
  title: string;
  columns: AdminTableColumn<T>[];
  rows: T[];
  emptyTitle: string;
}): string {
  return `
    <section class="admin-panel">
      <div class="admin-panel-header">
        <h2>${escapeAdminHtml(title)}</h2>
      </div>
      ${rows.length ? `
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>${columns.map(column => `<th>${escapeAdminHtml(column.label)}</th>`).join('')}</tr>
            </thead>
            <tbody>
              ${rows.map(row => `
                <tr>${columns.map(column => `<td>${column.render(row)}</td>`).join('')}</tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : renderAdminEmptyState(emptyTitle)}
    </section>
  `;
}

export function renderRecentUsersTable(rows: AdminRecentUser[]): string {
  return renderAdminTable({
    title: 'Recent users',
    rows,
    emptyTitle: 'No users found',
    columns: [
      { label: 'Name', render: row => escapeAdminHtml(row.full_name || '-') },
      { label: 'Email', render: row => escapeAdminHtml(row.email || '-') },
      { label: 'Role', render: row => `<span class="admin-pill">${escapeAdminHtml(row.role || 'user')}</span>` },
      { label: 'Created', render: row => escapeAdminHtml(formatAdminDate(row.created_at)) },
    ],
  });
}

export function renderRecentBusinessesTable(rows: AdminRecentBusiness[]): string {
  return renderAdminTable({
    title: 'Recent businesses',
    rows,
    emptyTitle: 'No businesses found',
    columns: [
      { label: 'Business name', render: row => escapeAdminHtml(row.business_name || '-') },
      { label: 'Owner email', render: row => escapeAdminHtml(row.owner_email || '-') },
      { label: 'Created', render: row => escapeAdminHtml(formatAdminDate(row.created_at)) },
      { label: 'Status', render: row => `<span class="admin-pill">${escapeAdminHtml(row.status || 'unknown')}</span>` },
    ],
  });
}

export function renderRecentPaymentsTable(rows: AdminRecentPayment[]): string {
  return renderAdminTable({
    title: 'Recent payments and subscriptions',
    rows,
    emptyTitle: 'No payment or subscription records found',
    columns: [
      { label: 'Customer', render: row => escapeAdminHtml(row.customer || '-') },
      { label: 'Plan', render: row => escapeAdminHtml(row.plan || '-') },
      { label: 'Amount', render: row => escapeAdminHtml(row.amount == null ? '-' : formatAdminMoney(row.amount)) },
      { label: 'Status', render: row => `<span class="admin-pill">${escapeAdminHtml(row.status || 'unknown')}</span>` },
      { label: 'Created', render: row => escapeAdminHtml(formatAdminDate(row.created_at)) },
    ],
  });
}
