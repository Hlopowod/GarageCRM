import { getSupabaseClient, isSupabaseConfigured } from './supabase';

const SNAPSHOT_TABLE = 'garage_account_snapshots';
const SESSION_KEY = 'garage-crm.web.session';
const SNAPSHOT_KEY_PREFIX = 'garage-crm.web.snapshot.';
const COLLECTIONS = [
  'clients',
  'vehicles',
  'job_cards',
  'job_lines',
  'invoices',
  'bookings',
  'inventory_items',
  'inventory_movements',
  'message_log',
  'sms_reminder_history',
];

const DEFAULT_SETTINGS = Object.freeze({
  garage_name: 'Garage CRM',
  garage_address: '',
  garage_phone: '',
  garage_email: '',
  garage_website: '',
  vat_number: '',
  company_number: '',
  bank_details: '',
  payment_terms: '',
  language: 'en',
  distance_unit: 'mi',
  currency: 'GBP',
  vat_enabled: true,
  default_vat_rate: 20,
  booking_slot_interval: 60,
  allow_past_booking_times: false,
  inventory_enabled: false,
});

const DEFAULT_MESSAGE_SETTINGS = Object.freeze({
  sms_enabled: false,
  auto_booking_sms: false,
  auto_job_completed_sms: false,
  manual_sms_enabled: true,
  booking_reminders_enabled: true,
  ready_messages_enabled: true,
  mot_reminders_enabled: true,
  service_reminders_enabled: true,
  reminder_30_days: true,
  reminder_14_days: true,
  reminder_7_days: true,
  reminder_due_today: true,
  automatic_reminder_time: '09:00',
  booking_days_before: 1,
  mot_days_before: 30,
  service_days_before: 30,
  garage_phone: '',
  booking_template: 'Hi {{customer_name}}, your booking with {{garage_name}} is confirmed for {{booking_date}} at {{booking_time}}. Vehicle: {{vehicle_reg}}. If you need to change it, please call {{garage_phone}}.',
  ready_template: 'Hi {{customer_name}}, your vehicle {{vehicle_reg}} is ready for collection. Amount to pay: GBP {{amount_due}}. {{garage_name}}',
  mot_template: 'Hi {{customer_name}}, MOT for {{vehicle_reg}} is due on {{mot_due_date}}. Please contact {{garage_name}} on {{garage_phone}} to book your MOT.',
  service_template: 'Hi {{customer_name}}, your vehicle {{vehicle_reg}} is due for service on {{service_due_date}}. Please contact {{garage_name}} on {{garage_phone}} to book.',
  completed_template: 'Hi {{customer_name}}, your vehicle {{vehicle_reg}} is ready for collection. Amount to pay: GBP {{amount_due}}. {{garage_name}}',
});

function canUseStorage() {
  return typeof window !== 'undefined' && Boolean(window.localStorage);
}

function readJson(key, fallback) {
  if (!canUseStorage()) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  if (!canUseStorage()) return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

function removeStorage(key) {
  if (!canUseStorage()) return;
  window.localStorage.removeItem(key);
}

function nowIso() {
  return new Date().toISOString();
}

function todayIso() {
  return nowIso().slice(0, 10);
}

function addDaysIso(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function toNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function toId(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.trunc(next) : null;
}

function roundMoney(value) {
  return Math.round(Math.max(0, toNumber(value)) * 100) / 100;
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function normalizeSnapshot(value = {}) {
  const snapshot = {
    schema_version: 5,
    synced_at: value.synced_at || '',
    garage: { ...DEFAULT_SETTINGS, ...(value.garage || {}) },
    message_settings: { ...DEFAULT_MESSAGE_SETTINGS, ...(value.message_settings || {}) },
  };
  for (const key of COLLECTIONS) {
    snapshot[key] = Array.isArray(value[key]) ? value[key].map(item => ({ ...item })) : [];
  }
  return snapshot;
}

function emptySnapshot() {
  return normalizeSnapshot({ synced_at: nowIso() });
}

function getStoredSession() {
  return readJson(SESSION_KEY, null);
}

function saveStoredSession(session) {
  writeJson(SESSION_KEY, session);
}

async function getSupabaseSession() {
  if (!isSupabaseConfigured()) return null;
  const client = getSupabaseClient();
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  if (data.session) return data.session;

  const stored = getStoredSession();
  if (!stored?.access_token || !stored.refresh_token) return null;
  const restored = await client.auth.setSession({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token,
  });
  if (restored.error) {
    removeStorage(SESSION_KEY);
    return null;
  }
  return restored.data.session || null;
}

async function getSessionStatus() {
  const session = await getSupabaseSession();
  const stored = getStoredSession();
  const user = session?.user;
  return {
    configured: isSupabaseConfigured(),
    account_email: user?.email || stored?.account_email || '',
    user_id: user?.id || stored?.user_id || '',
    last_synced_at: stored?.last_synced_at || '',
  };
}

async function requireSession() {
  const session = await getSupabaseSession();
  if (!session?.user?.id) {
    throw new Error('Sign in to use the online workspace.');
  }
  return session;
}

async function snapshotKey() {
  const status = await getSessionStatus();
  return `${SNAPSHOT_KEY_PREFIX}${status.user_id || 'anonymous'}`;
}

async function loadLocalSnapshot() {
  return normalizeSnapshot(readJson(await snapshotKey(), emptySnapshot()));
}

async function saveLocalSnapshot(snapshot) {
  writeJson(await snapshotKey(), normalizeSnapshot(snapshot));
}

async function mutateSnapshot(mutator) {
  const snapshot = await loadLocalSnapshot();
  const result = await mutator(snapshot);
  await saveLocalSnapshot(snapshot);
  return result;
}

function maxId(items) {
  return items.reduce((max, item) => Math.max(max, toId(item.id) || 0), 0);
}

function saveRecord(snapshot, collection, record) {
  const items = snapshot[collection];
  const id = toId(record.id);
  if (id) {
    const index = items.findIndex(item => toId(item.id) === id);
    if (index === -1) throw new Error('Record not found.');
    items[index] = { ...items[index], ...record, id };
    return id;
  }
  const nextId = maxId(items) + 1;
  items.push({ ...record, id: nextId });
  return nextId;
}

function deleteRecord(snapshot, collection, id) {
  const numericId = toId(id);
  snapshot[collection] = snapshot[collection].filter(item => toId(item.id) !== numericId);
}

function findById(items, id) {
  const numericId = toId(id);
  return items.find(item => toId(item.id) === numericId) || null;
}

function normalizeJobLineStatus(value) {
  const status = cleanString(value).toLowerCase();
  if (status === 'draft') return 'draft';
  if (status === 'declined') return 'declined';
  return 'confirmed';
}

function normalizeMovementType(value) {
  const text = cleanString(value);
  if (/stock\s*out/i.test(text)) return 'Stock Out';
  if (/adjust/i.test(text)) return 'Adjustment';
  return 'Stock In';
}

function resolveInventoryPricing(item) {
  const purchaseCost = Math.max(0, toNumber(item.purchase_cost));
  const mode = cleanString(item.price_mode) === 'manual' ? 'manual' : 'auto';
  let sellPrice = Math.max(0, toNumber(item.sell_price));
  let marginPercent = Math.max(0, toNumber(item.margin_percent));
  if (mode === 'auto') {
    sellPrice = roundMoney(purchaseCost * (1 + marginPercent / 100));
  } else if (purchaseCost > 0) {
    marginPercent = Math.round(((sellPrice - purchaseCost) / purchaseCost) * 10000) / 100;
  }
  return { sell_price: sellPrice, margin_percent: marginPercent, price_mode: mode };
}

function lineSubtotal(snapshot, jobId) {
  const numericJobId = toId(jobId);
  return roundMoney(snapshot.job_lines
    .filter(line => toId(line.job_id) === numericJobId)
    .reduce((sum, line) => sum + toNumber(line.qty) * toNumber(line.unit_price), 0));
}

function invoiceVatRate(snapshot, invoice = {}) {
  if (invoice.vat_rate !== undefined && invoice.vat_rate !== null) return toNumber(invoice.vat_rate);
  return snapshot.garage.vat_enabled ? toNumber(snapshot.garage.default_vat_rate, 20) : 0;
}

function invoiceTotals(snapshot, invoice) {
  const subtotal = lineSubtotal(snapshot, invoice.job_id);
  const vatRate = invoiceVatRate(snapshot, invoice);
  const vat = roundMoney(subtotal * vatRate / 100);
  const total = roundMoney(subtotal + vat);
  return { subtotal, vat, total, vat_rate: vatRate };
}

function formatInvoiceNumber(snapshot) {
  return `INV-${Math.max(1000, maxId(snapshot.invoices)) + 1}`;
}

function clientBalance(snapshot, clientId) {
  const jobs = snapshot.job_cards.filter(job => toId(job.client_id) === toId(clientId));
  const jobIds = new Set(jobs.map(job => toId(job.id)));
  return roundMoney(snapshot.invoices
    .filter(invoice => jobIds.has(toId(invoice.job_id)) && ['Unpaid', 'Partial'].includes(cleanString(invoice.status)))
    .reduce((sum, invoice) => {
      const total = invoiceTotals(snapshot, invoice).total;
      return sum + (cleanString(invoice.status) === 'Partial' ? Math.max(0, total - toNumber(invoice.paid_amount)) : total);
    }, 0));
}

function mapClient(snapshot, client) {
  const clientJobs = snapshot.job_cards.filter(job => toId(job.client_id) === toId(client.id));
  const lastVisit = clientJobs
    .map(job => cleanString(job.date_opened))
    .filter(Boolean)
    .sort()
    .pop() || '';
  return {
    ...client,
    vehicle_count: snapshot.vehicles.filter(vehicle => toId(vehicle.client_id) === toId(client.id)).length,
    last_visit: lastVisit,
    balance: clientBalance(snapshot, client.id),
  };
}

function mapVehicle(snapshot, vehicle) {
  const client = findById(snapshot.clients, vehicle.client_id);
  return { ...vehicle, client_name: client?.name || '' };
}

function mapBooking(snapshot, booking) {
  const client = findById(snapshot.clients, booking.client_id);
  const vehicle = findById(snapshot.vehicles, booking.vehicle_id);
  return {
    ...booking,
    client_name: client?.name || '',
    registration: vehicle?.registration || '',
    make: vehicle?.make || '',
    model: vehicle?.model || '',
  };
}

function mapJob(snapshot, job) {
  const client = findById(snapshot.clients, job.client_id);
  const vehicle = findById(snapshot.vehicles, job.vehicle_id);
  const booking = findById(snapshot.bookings, job.booking_id);
  return {
    ...job,
    client_name: client?.name || '',
    registration: vehicle?.registration || '',
    make: vehicle?.make || '',
    model: vehicle?.model || '',
    booking_date: booking?.date || '',
    booking_time: booking?.time || '',
    booking_reason: booking?.reason || '',
    subtotal: lineSubtotal(snapshot, job.id),
  };
}

function mapJobLine(snapshot, line) {
  const item = findById(snapshot.inventory_items, line.inventory_item_id);
  return {
    ...line,
    line_status: normalizeJobLineStatus(line.line_status),
    inventory_part_name: item?.part_name || '',
    inventory_sku: item?.sku || '',
    inventory_category: item?.category || '',
    inventory_supplier: item?.supplier || '',
    inventory_stock_qty_applied: toNumber(line.inventory_stock_qty_applied),
  };
}

function mapInvoice(snapshot, invoice) {
  const job = findById(snapshot.job_cards, invoice.job_id);
  const client = job ? findById(snapshot.clients, job.client_id) : null;
  const vehicle = job ? findById(snapshot.vehicles, job.vehicle_id) : null;
  const totals = invoiceTotals(snapshot, invoice);
  return {
    ...invoice,
    vat_rate: totals.vat_rate,
    client_name: client?.name || '',
    registration: vehicle?.registration || '',
    make: vehicle?.make || '',
    model: vehicle?.model || '',
    subtotal: totals.subtotal,
    vat: totals.vat,
    total: totals.total,
  };
}

function mapInventoryItem(item) {
  const pricing = resolveInventoryPricing(item);
  const quantity = Math.max(0, toNumber(item.quantity));
  const purchaseCost = Math.max(0, toNumber(item.purchase_cost));
  return {
    ...item,
    quantity,
    purchase_cost: purchaseCost,
    ...pricing,
    inventory_value: roundMoney(quantity * purchaseCost),
    retail_value: roundMoney(quantity * pricing.sell_price),
    gross_profit_each: roundMoney(pricing.sell_price - purchaseCost),
  };
}

function mapMovement(snapshot, movement) {
  const item = findById(snapshot.inventory_items, movement.inventory_item_id);
  return {
    ...movement,
    movement_type: normalizeMovementType(movement.movement_type),
    part_name: item?.part_name || '',
    sku: item?.sku || '',
  };
}

function insertInventoryMovement(snapshot, itemId, movementType, quantity, notes) {
  const id = maxId(snapshot.inventory_movements) + 1;
  snapshot.inventory_movements.push({
    id,
    inventory_item_id: toId(itemId),
    movement_type: normalizeMovementType(movementType),
    quantity: toNumber(quantity),
    movement_date: todayIso(),
    notes: cleanString(notes),
  });
  return id;
}

async function callFunction(name, body) {
  if (!isSupabaseConfigured()) throw new Error('Supabase is not configured.');
  const client = getSupabaseClient();
  const { data, error } = await client.functions.invoke(name, { body });
  if (error) throw error;
  return data;
}

async function getRemoteSnapshotRow() {
  const session = await requireSession();
  const client = getSupabaseClient();
  const { data, error } = await client
    .from(SNAPSHOT_TABLE)
    .select('snapshot,synced_at,updated_at,account_email,garage_name')
    .eq('user_id', session.user.id)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getCommands(command, args) {
  const snapshot = await loadLocalSnapshot();
  switch (command) {
    case 'get_app_settings':
      return snapshot.garage;
    case 'get_message_settings':
      return snapshot.message_settings;
    case 'get_message_log':
      return snapshot.message_log.slice().sort((a, b) => toId(b.id) - toId(a.id)).slice(0, args?.limit || 100);
    case 'get_clients':
      return snapshot.clients.map(client => mapClient(snapshot, client)).sort((a, b) => cleanString(a.name).localeCompare(cleanString(b.name)));
    case 'get_vehicles': {
      const clientId = args?.clientId ?? args?.client_id ?? null;
      return snapshot.vehicles
        .filter(vehicle => !clientId || toId(vehicle.client_id) === toId(clientId))
        .map(vehicle => mapVehicle(snapshot, vehicle))
        .sort((a, b) => cleanString(a.registration).localeCompare(cleanString(b.registration)));
    }
    case 'get_job_cards':
      return snapshot.job_cards.map(job => mapJob(snapshot, job)).sort((a, b) => cleanString(b.date_opened).localeCompare(cleanString(a.date_opened)));
    case 'get_job_lines':
      return snapshot.job_lines
        .filter(line => toId(line.job_id) === toId(args?.jobId ?? args?.job_id))
        .map(line => mapJobLine(snapshot, line))
        .sort((a, b) => toId(a.id) - toId(b.id));
    case 'get_invoices':
      return snapshot.invoices.map(invoice => mapInvoice(snapshot, invoice)).sort((a, b) => cleanString(b.date_issued).localeCompare(cleanString(a.date_issued)));
    case 'get_bookings':
      return snapshot.bookings.map(booking => mapBooking(snapshot, booking)).sort((a, b) => `${a.date || ''} ${a.time || ''}`.localeCompare(`${b.date || ''} ${b.time || ''}`));
    case 'get_inventory_items':
      return snapshot.inventory_items.map(mapInventoryItem).sort((a, b) => cleanString(a.part_name).localeCompare(cleanString(b.part_name)));
    case 'get_inventory_movements':
      return snapshot.inventory_movements.map(movement => mapMovement(snapshot, movement)).sort((a, b) => cleanString(b.movement_date).localeCompare(cleanString(a.movement_date)) || toId(b.id) - toId(a.id));
    case 'get_dashboard':
      return {
        clients: snapshot.clients.length,
        vehicles: snapshot.vehicles.length,
        jobs: snapshot.job_cards.length,
        invoices: snapshot.invoices.length,
        bookings: snapshot.bookings.length,
      };
    case 'get_app_update_state':
      return { currentVersion: 'web', configured: false };
    case 'get_cloud_account_status':
      return getSessionStatus();
    case 'get_supabase_auth_session': {
      const session = await getSupabaseSession();
      if (!session) return null;
      return {
        account_email: session.user.email || '',
        user_id: session.user.id,
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      };
    }
    case 'get_cloud_remote_snapshot_status': {
      const row = await getRemoteSnapshotRow();
      return {
        exists: Boolean(row),
        synced_at: row?.synced_at || '',
        updated_at: row?.updated_at || '',
        account_email: row?.account_email || '',
      };
    }
    case 'plugin:deep-link|get_current':
      return typeof window === 'undefined' ? [] : [window.location.href];
    default:
      return null;
  }
}

async function saveCommands(command, args) {
  switch (command) {
    case 'save_app_settings':
      return mutateSnapshot(snapshot => {
        snapshot.garage = { ...DEFAULT_SETTINGS, ...(snapshot.garage || {}), ...(args?.settings || {}) };
        return snapshot.garage;
      });
    case 'save_message_settings':
      return mutateSnapshot(snapshot => {
        snapshot.message_settings = { ...DEFAULT_MESSAGE_SETTINGS, ...(snapshot.message_settings || {}), ...(args?.settings || {}) };
        return snapshot.message_settings;
      });
    case 'save_client':
      return mutateSnapshot(snapshot => saveRecord(snapshot, 'clients', {
        phone: '',
        email: '',
        address: '',
        company: '',
        notes: '',
        cloud_account_email: '',
        cloud_user_id: '',
        cloud_last_synced_at: '',
        cloud_sync_status: '',
        ...(args?.client || {}),
      }));
    case 'save_vehicle':
      return mutateSnapshot(snapshot => saveRecord(snapshot, 'vehicles', {
        vin: '',
        make: '',
        model: '',
        year: 0,
        engine: '',
        fuel_type: '',
        colour: '',
        mileage: 0,
        mot_due: '',
        service_due: '',
        notes: '',
        ...(args?.vehicle || {}),
      }));
    case 'save_job_card':
      return mutateSnapshot(snapshot => saveRecord(snapshot, 'job_cards', {
        status: 'Booked',
        complaint: '',
        findings: '',
        work_performed: '',
        mechanic: '',
        mileage_in: 0,
        mileage_out: 0,
        est_completion: '',
        internal_notes: '',
        customer_notes: '',
        date_opened: todayIso(),
        ...(args?.job || {}),
      }));
    case 'save_job_line':
      return mutateSnapshot(snapshot => saveRecord(snapshot, 'job_lines', {
        line_type: 'Labour',
        description: '',
        qty: 1,
        unit_price: 0,
        line_status: 'confirmed',
        inventory_item_id: null,
        inventory_stock_qty_applied: 0,
        ...(args?.line || {}),
      }));
    case 'save_invoice':
      return mutateSnapshot(snapshot => {
        const invoice = { ...(args?.invoice || {}) };
        const totals = invoiceTotals(snapshot, invoice);
        const status = ['Paid', 'Partial'].includes(cleanString(invoice.status)) ? cleanString(invoice.status) : 'Unpaid';
        invoice.invoice_number = cleanString(invoice.invoice_number) || (toId(invoice.id) ? `INV-${toId(invoice.id)}` : formatInvoiceNumber(snapshot));
        invoice.date_issued = invoice.date_issued || todayIso();
        invoice.due_date = invoice.due_date || addDaysIso(7);
        invoice.status = status;
        invoice.vat_rate = totals.vat_rate;
        invoice.payment_method = cleanString(invoice.payment_method);
        invoice.notes = cleanString(invoice.notes);
        invoice.paid_amount = status === 'Paid' ? totals.total : (status === 'Partial' ? roundMoney(Math.min(Math.max(0, toNumber(invoice.paid_amount)), totals.total)) : 0);
        return saveRecord(snapshot, 'invoices', invoice);
      });
    case 'save_booking':
      return mutateSnapshot(snapshot => saveRecord(snapshot, 'bookings', {
        date: todayIso(),
        time: '09:00',
        reason: '',
        status: 'Booked',
        notes: '',
        ...(args?.booking || {}),
      }));
    case 'save_inventory_item':
      return mutateSnapshot(snapshot => {
        const item = { quantity: 0, minimum_stock_level: 0, purchase_cost: 0, sell_price: 0, margin_percent: 0, price_mode: 'auto', notes: '', ...(args?.item || {}) };
        if (!cleanString(item.part_name)) throw new Error('Part name is required.');
        const previous = item.id ? findById(snapshot.inventory_items, item.id) : null;
        const pricing = resolveInventoryPricing(item);
        const id = saveRecord(snapshot, 'inventory_items', { ...item, ...pricing });
        const quantity = toNumber(item.quantity);
        const previousQuantity = previous ? toNumber(previous.quantity) : 0;
        const delta = quantity - previousQuantity;
        if (Math.abs(delta) > Number.EPSILON) {
          insertInventoryMovement(snapshot, id, 'Adjustment', delta, previous ? 'Manual inventory edit' : 'Opening stock');
        }
        return id;
      });
    case 'adjust_inventory_stock':
      return mutateSnapshot(snapshot => {
        const movement = args?.movement || {};
        const item = findById(snapshot.inventory_items, movement.inventory_item_id);
        if (!item) throw new Error('Inventory item not found.');
        const movementType = normalizeMovementType(movement.movement_type);
        const rawQuantity = Math.abs(toNumber(movement.quantity));
        const delta = movementType === 'Stock Out' ? -rawQuantity : (movementType === 'Adjustment' ? toNumber(movement.quantity) : rawQuantity);
        if (Math.abs(delta) <= Number.EPSILON) throw new Error('Enter a stock quantity to record.');
        const nextQuantity = toNumber(item.quantity) + delta;
        if (nextQuantity < 0) throw new Error('Stock cannot go below zero.');
        item.quantity = Math.round(nextQuantity * 100) / 100;
        return insertInventoryMovement(snapshot, item.id, movementType, movementType === 'Adjustment' ? delta : Math.abs(delta), movement.notes || '');
      });
    default:
      return null;
  }
}

async function deleteCommands(command, args) {
  switch (command) {
    case 'delete_client':
      return mutateSnapshot(snapshot => {
        const id = args?.id;
        if (snapshot.job_cards.some(job => toId(job.client_id) === toId(id)) || snapshot.bookings.some(booking => toId(booking.client_id) === toId(id))) {
          throw new Error('Cannot delete client while linked work exists.');
        }
        snapshot.vehicles = snapshot.vehicles.filter(vehicle => toId(vehicle.client_id) !== toId(id));
        deleteRecord(snapshot, 'clients', id);
      });
    case 'delete_vehicle':
      return mutateSnapshot(snapshot => {
        const id = args?.id;
        if (snapshot.job_cards.some(job => toId(job.vehicle_id) === toId(id))) {
          throw new Error('Cannot delete vehicle while linked job cards exist.');
        }
        if (snapshot.bookings.some(booking => toId(booking.vehicle_id) === toId(id)) && args?.deleteBookings !== true) {
          throw new Error('This vehicle has booking(s). Confirm deleting those bookings first.');
        }
        snapshot.bookings = snapshot.bookings.filter(booking => toId(booking.vehicle_id) !== toId(id));
        deleteRecord(snapshot, 'vehicles', id);
      });
    case 'delete_job_line':
      return mutateSnapshot(snapshot => deleteRecord(snapshot, 'job_lines', args?.id));
    case 'delete_booking':
      return mutateSnapshot(snapshot => {
        const id = args?.bookingId ?? args?.booking_id;
        snapshot.job_cards = snapshot.job_cards.map(job => toId(job.booking_id) === toId(id) ? { ...job, booking_id: null } : job);
        deleteRecord(snapshot, 'bookings', id);
      });
    case 'delete_inventory_item':
      return mutateSnapshot(snapshot => {
        deleteRecord(snapshot, 'inventory_items', args?.id);
        snapshot.inventory_movements = snapshot.inventory_movements.filter(movement => toId(movement.inventory_item_id) !== toId(args?.id));
      });
    default:
      return null;
  }
}

async function cloudCommands(command, args) {
  switch (command) {
    case 'save_supabase_auth_session': {
      const payload = args?.session || {};
      const userId = payload.userId || payload.user_id || '';
      const current = getStoredSession();
      const next = {
        account_email: payload.accountEmail || payload.account_email || '',
        user_id: userId,
        access_token: payload.accessToken || payload.access_token || '',
        refresh_token: payload.refreshToken || payload.refresh_token || '',
        last_synced_at: current?.user_id === userId ? (current.last_synced_at || '') : '',
      };
      saveStoredSession(next);
      return getSessionStatus();
    }
    case 'clear_supabase_auth_session':
      removeStorage(SESSION_KEY);
      return getSessionStatus();
    case 'sync_account_to_cloud': {
      const session = await requireSession();
      const snapshot = await loadLocalSnapshot();
      snapshot.synced_at = nowIso();
      await saveLocalSnapshot(snapshot);
      const garageName = snapshot.garage?.garage_name || 'Garage CRM';
      const client = getSupabaseClient();
      const { data, error } = await client
        .from(SNAPSHOT_TABLE)
        .upsert({
          user_id: session.user.id,
          account_email: session.user.email || '',
          garage_name: garageName,
          snapshot,
          synced_at: snapshot.synced_at,
        }, { onConflict: 'user_id' })
        .select()
        .limit(1);
      if (error) throw error;
      const stored = getStoredSession() || {};
      saveStoredSession({ ...stored, account_email: session.user.email || stored.account_email || '', user_id: session.user.id, access_token: session.access_token, refresh_token: session.refresh_token, last_synced_at: snapshot.synced_at });
      return { synced_at: snapshot.synced_at, remote: data };
    }
    case 'restore_account_from_cloud': {
      const row = await getRemoteSnapshotRow();
      if (!row?.snapshot) {
        await saveLocalSnapshot(emptySnapshot());
        return { restored: false, synced_at: '', message: 'No cloud snapshot found for this account yet.' };
      }
      const snapshot = normalizeSnapshot(row.snapshot);
      snapshot.synced_at = row.synced_at || snapshot.synced_at || nowIso();
      await saveLocalSnapshot(snapshot);
      const stored = getStoredSession() || {};
      saveStoredSession({ ...stored, account_email: row.account_email || stored.account_email || '', last_synced_at: snapshot.synced_at });
      return { restored: true, synced_at: snapshot.synced_at };
    }
    case 'send_sms_message': {
      const message = args?.message || {};
      const result = await callFunction('send-sms', message);
      await mutateSnapshot(snapshot => {
        const id = maxId(snapshot.message_log) + 1;
        snapshot.message_log.push({
          id,
          channel: 'sms',
          category: message.category || '',
          customer_id: message.customer_id || null,
          vehicle_id: message.vehicle_id || null,
          booking_id: message.booking_id || null,
          job_card_id: message.job_card_id || null,
          reminder_type: message.reminder_type || '',
          reminder_stage: message.reminder_stage || '',
          recipient_name: message.recipient_name || '',
          recipient_phone: message.to || '',
          body: message.body || '',
          status: result?.status || 'sent',
          related_type: message.related_type || '',
          related_id: message.related_id || null,
          error: '',
          provider_message_id: result?.provider_message_id || result?.sid || '',
          scheduled_for: message.scheduled_for || '',
          sent_at: nowIso(),
          created_at: nowIso(),
        });
        return id;
      });
      return result || { status: 'sent' };
    }
    case 'lookup_vehicle_registration':
      return callFunction('dvla-vehicle-lookup', { registrationNumber: args?.registration || args?.registrationNumber || '' });
    default:
      return null;
  }
}

async function utilityCommands(command, args) {
  switch (command) {
    case 'generate_invoice':
      return mutateSnapshot(snapshot => {
        const jobId = args?.jobId ?? args?.job_id;
        const existing = snapshot.invoices.find(invoice => toId(invoice.job_id) === toId(jobId));
        if (existing) return toId(existing.id);
        const invoice = {
          job_id: toId(jobId),
          invoice_number: formatInvoiceNumber(snapshot),
          date_issued: todayIso(),
          due_date: addDaysIso(7),
          status: 'Unpaid',
          payment_method: '',
          paid_amount: 0,
          notes: '',
          vat_rate: snapshot.garage.vat_enabled ? toNumber(snapshot.garage.default_vat_rate, 20) : 0,
        };
        return saveRecord(snapshot, 'invoices', invoice);
      });
    case 'mark_invoice_paid':
      return mutateSnapshot(snapshot => {
        const invoice = findById(snapshot.invoices, args?.id);
        if (!invoice) throw new Error('Invoice not found.');
        const totals = invoiceTotals(snapshot, invoice);
        invoice.status = 'Paid';
        invoice.payment_method = args?.method || '';
        invoice.paid_amount = totals.total;
      });
    case 'search': {
      const snapshot = await loadLocalSnapshot();
      const query = cleanString(args?.query).toLowerCase();
      return {
        clients: snapshot.clients
          .filter(client => cleanString(client.name).toLowerCase().includes(query) || cleanString(client.phone).toLowerCase().includes(query))
          .slice(0, 5)
          .map(client => ({ type: 'client', id: client.id, label: `${client.name || ''} - ${client.phone || ''}` })),
        vehicles: snapshot.vehicles
          .filter(vehicle => cleanString(vehicle.registration).toLowerCase().includes(query) || cleanString(vehicle.vin).toLowerCase().includes(query))
          .slice(0, 5)
          .map(vehicle => ({ type: 'vehicle', id: vehicle.id, label: `${vehicle.registration || ''} - ${vehicle.make || ''} ${vehicle.model || ''}` })),
      };
    }
    case 'check_for_app_update':
      return null;
    case 'install_app_update':
      throw new Error('Desktop updates are not used in the web version.');
    default:
      return null;
  }
}

export async function invokeWebCommand(command, args = undefined) {
  const handlers = [cloudCommands, getCommands, saveCommands, deleteCommands, utilityCommands];
  for (const handler of handlers) {
    const result = await handler(command, args || {});
    if (result !== null) return result;
  }
  throw new Error(`Unsupported web command: ${command}`);
}
