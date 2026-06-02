use reqwest::blocking::Client as HttpClient;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

struct DbState(Mutex<Connection>);
const SUPABASE_APP_ACCOUNTS_TABLE: &str = "garage_account_snapshots";
const SUPABASE_SMS_FUNCTION: &str = "send-sms";
const DEFAULT_CLOUD_ACCESS_TOKEN_SECONDS: i64 = 60 * 60;
const CLOUD_SESSION_REFRESH_LEEWAY_SECONDS: i64 = 2 * 60;
const MAX_CLOUD_ACCESS_TOKEN_SECONDS: i64 = 24 * 60 * 60;
const CLOUD_HTTP_TIMEOUT_SECONDS: u64 = 20;
struct PendingUpdate(Mutex<Option<Update>>);

fn install_rustls_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CloudSession {
    pub account_email: String,
    pub user_id: String,
    pub access_token: String,
    pub refresh_token: String,
    pub last_synced_at: String,
    pub session_expires_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CloudAccountStatus {
    pub configured: bool,
    pub account_email: String,
    pub user_id: String,
    pub last_synced_at: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct StoredSupabaseAuthSession {
    pub account_email: String,
    pub user_id: String,
    pub access_token: String,
    pub refresh_token: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CloudAuthResult {
    pub status: CloudAccountStatus,
    pub signed_in: bool,
    pub requires_email_confirmation: bool,
    pub message: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct SupabaseAuthSessionPayload {
    account_email: String,
    user_id: String,
    access_token: String,
    refresh_token: String,
    #[serde(default)]
    expires_at: Option<i64>,
    #[serde(default)]
    expires_in: Option<i64>,
}

#[derive(Debug, Clone)]
struct CloudBuildConfig {
    supabase_url: String,
    supabase_anon_key: String,
}

#[derive(Debug, Clone)]
struct UpdaterBuildConfig {
    endpoint: String,
    pubkey: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct AppUpdateState {
    current_version: String,
    configured: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct AppUpdateMetadata {
    version: String,
    current_version: String,
    notes: String,
    pub_date: String,
}

#[derive(Serialize, Debug, Clone)]
struct CloudRemoteSnapshotStatus {
    exists: bool,
    synced_at: String,
    updated_at: String,
    account_email: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MessageSettings {
    #[serde(default)]
    pub sms_enabled: bool,
    #[serde(default)]
    pub auto_booking_sms: bool,
    #[serde(default)]
    pub auto_job_completed_sms: bool,
    #[serde(default = "default_true")]
    pub manual_sms_enabled: bool,
    #[serde(default = "default_true")]
    pub booking_reminders_enabled: bool,
    #[serde(default = "default_true")]
    pub ready_messages_enabled: bool,
    #[serde(default = "default_true")]
    pub mot_reminders_enabled: bool,
    #[serde(default = "default_true")]
    pub service_reminders_enabled: bool,
    #[serde(default = "default_automatic_reminder_time")]
    pub automatic_reminder_time: String,
    #[serde(default = "default_booking_message_lead_days")]
    pub booking_days_before: i64,
    #[serde(default = "default_message_lead_days")]
    pub mot_days_before: i64,
    #[serde(default = "default_message_lead_days")]
    pub service_days_before: i64,
    #[serde(default)]
    pub garage_phone: String,
    #[serde(default = "default_booking_message_template")]
    pub booking_template: String,
    #[serde(default = "default_ready_message_template")]
    pub ready_template: String,
    #[serde(default = "default_mot_message_template")]
    pub mot_template: String,
    #[serde(default = "default_service_message_template")]
    pub service_template: String,
    #[serde(default = "default_completed_message_template")]
    pub completed_template: String,
    #[serde(default = "default_true")]
    pub reminder_30_days: bool,
    #[serde(default = "default_true")]
    pub reminder_14_days: bool,
    #[serde(default = "default_true")]
    pub reminder_7_days: bool,
    #[serde(default = "default_true")]
    pub reminder_due_today: bool,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SmsMessagePayload {
    pub category: String,
    pub to: String,
    pub body: String,
    #[serde(default)]
    pub recipient_name: String,
    #[serde(default)]
    pub related_type: String,
    #[serde(default)]
    pub related_id: Option<i64>,
    #[serde(default)]
    pub scheduled_for: String,
    #[serde(default)]
    pub customer_id: Option<i64>,
    #[serde(default)]
    pub vehicle_id: Option<i64>,
    #[serde(default)]
    pub booking_id: Option<i64>,
    #[serde(default)]
    pub job_card_id: Option<i64>,
    #[serde(default)]
    pub reminder_type: String,
    #[serde(default)]
    pub reminder_stage: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Client {
    pub id: Option<i64>,
    pub name: String,
    pub phone: String,
    pub email: String,
    pub address: String,
    pub company: String,
    pub notes: String,
    #[serde(default)]
    pub cloud_account_email: String,
    #[serde(default)]
    pub cloud_user_id: String,
    #[serde(default)]
    pub cloud_last_synced_at: String,
    #[serde(default)]
    pub cloud_sync_status: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Vehicle {
    pub id: Option<i64>,
    pub client_id: i64,
    pub registration: String,
    pub vin: String,
    pub make: String,
    pub model: String,
    pub year: i32,
    pub engine: String,
    pub fuel_type: String,
    pub colour: String,
    pub mileage: i64,
    pub mot_due: String,
    pub service_due: String,
    pub notes: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct JobCard {
    pub id: Option<i64>,
    pub client_id: i64,
    pub vehicle_id: i64,
    #[serde(default)]
    pub booking_id: Option<i64>,
    pub status: String,
    pub complaint: String,
    pub findings: String,
    pub work_performed: String,
    pub mechanic: String,
    pub mileage_in: i64,
    pub mileage_out: i64,
    pub est_completion: String,
    pub internal_notes: String,
    pub customer_notes: String,
    pub date_opened: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct JobLine {
    pub id: Option<i64>,
    pub job_id: i64,
    pub line_type: String,
    pub description: String,
    pub qty: f64,
    pub unit_price: f64,
    #[serde(default)]
    pub inventory_item_id: Option<i64>,
    #[serde(default = "default_job_line_status")]
    pub line_status: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Invoice {
    pub id: Option<i64>,
    pub job_id: i64,
    pub invoice_number: String,
    pub date_issued: String,
    pub due_date: String,
    pub status: String,
    pub payment_method: String,
    #[serde(default)]
    pub paid_amount: f64,
    pub notes: String,
    pub vat_rate: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Booking {
    pub id: Option<i64>,
    pub client_id: i64,
    pub vehicle_id: i64,
    pub date: String,
    pub time: String,
    pub reason: String,
    pub status: String,
    pub notes: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct InventoryItem {
    pub id: Option<i64>,
    pub part_name: String,
    pub sku: String,
    pub category: String,
    pub supplier: String,
    pub quantity: f64,
    pub minimum_stock_level: f64,
    pub purchase_cost: f64,
    #[serde(default)]
    pub sell_price: f64,
    #[serde(default)]
    pub margin_percent: f64,
    #[serde(default = "default_inventory_price_mode")]
    pub price_mode: String,
    pub notes: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct InventoryMovement {
    pub id: Option<i64>,
    pub inventory_item_id: i64,
    pub movement_type: String,
    pub quantity: f64,
    #[serde(default)]
    pub movement_date: String,
    pub notes: String,
}

fn default_booking_slot_interval() -> i64 {
    60
}

fn default_allow_past_booking_times() -> bool {
    false
}

fn default_vat_enabled() -> bool {
    true
}

fn default_vat_rate() -> f64 {
    20.0
}

fn default_language() -> String {
    "en".to_string()
}

fn invoice_vat_rate_from_settings(settings: &AppSettings) -> f64 {
    if settings.vat_enabled {
        settings.default_vat_rate
    } else {
        0.0
    }
}

fn round_money(value: f64) -> f64 {
    (value.max(0.0) * 100.0).round() / 100.0
}

fn default_job_line_status() -> String {
    "confirmed".to_string()
}

fn default_inventory_price_mode() -> String {
    "auto".to_string()
}

fn default_true() -> bool {
    true
}

fn default_booking_message_lead_days() -> i64 {
    1
}

fn default_message_lead_days() -> i64 {
    30
}

fn default_automatic_reminder_time() -> String {
    "09:00".to_string()
}

fn default_booking_message_template() -> String {
    "Hi {{customer_name}}, your booking with {{garage_name}} is confirmed for {{booking_date}} at {{booking_time}}. Vehicle: {{vehicle_reg}}. If you need to change it, please call {{garage_phone}}.".to_string()
}

fn default_ready_message_template() -> String {
    default_completed_message_template()
}

fn default_mot_message_template() -> String {
    "Hi {{customer_name}}, MOT for {{vehicle_reg}} is due on {{mot_due_date}}. Please contact {{garage_name}} on {{garage_phone}} to book your MOT.".to_string()
}

fn default_service_message_template() -> String {
    "Hi {{customer_name}}, your vehicle {{vehicle_reg}} is due for service on {{service_due_date}}. Please contact {{garage_name}} on {{garage_phone}} to book.".to_string()
}

fn default_completed_message_template() -> String {
    "Hi {{customer_name}}, your vehicle {{vehicle_reg}} is ready for collection. Amount to pay: £{{amount_due}}. {{garage_name}}".to_string()
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AppSettings {
    pub garage_name: String,
    #[serde(default)]
    pub garage_address: String,
    #[serde(default)]
    pub garage_phone: String,
    #[serde(default)]
    pub garage_email: String,
    #[serde(default)]
    pub garage_website: String,
    #[serde(default)]
    pub vat_number: String,
    #[serde(default)]
    pub company_number: String,
    #[serde(default)]
    pub bank_details: String,
    #[serde(default)]
    pub payment_terms: String,
    #[serde(default = "default_language")]
    pub language: String,
    pub distance_unit: String,
    pub currency: String,
    #[serde(default = "default_vat_enabled")]
    pub vat_enabled: bool,
    #[serde(default = "default_vat_rate")]
    pub default_vat_rate: f64,
    #[serde(default = "default_booking_slot_interval")]
    pub booking_slot_interval: i64,
    #[serde(default = "default_allow_past_booking_times")]
    pub allow_past_booking_times: bool,
    #[serde(default)]
    pub inventory_enabled: bool,
    #[serde(default)]
    pub supabase_url: String,
    #[serde(default, skip_serializing)]
    pub supabase_service_role_key: String,
}

fn init_db(conn: &Connection) {
    conn.execute_batch(
        "
        PRAGMA foreign_keys=ON;
        PRAGMA journal_mode=WAL;

        CREATE TABLE IF NOT EXISTS clients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT,
            email TEXT,
            address TEXT,
            company TEXT,
            notes TEXT
        );

        CREATE TABLE IF NOT EXISTS vehicles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
            registration TEXT,
            vin TEXT,
            make TEXT,
            model TEXT,
            year INTEGER,
            engine TEXT,
            fuel_type TEXT,
            colour TEXT,
            mileage INTEGER DEFAULT 0,
            mot_due TEXT,
            service_due TEXT,
            notes TEXT
        );

        CREATE TABLE IF NOT EXISTS job_cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id INTEGER REFERENCES clients(id),
            vehicle_id INTEGER REFERENCES vehicles(id),
            booking_id INTEGER,
            status TEXT DEFAULT 'New',
            complaint TEXT,
            findings TEXT,
            work_performed TEXT,
            mechanic TEXT,
            mileage_in INTEGER DEFAULT 0,
            mileage_out INTEGER DEFAULT 0,
            est_completion TEXT,
            internal_notes TEXT,
            customer_notes TEXT,
            date_opened TEXT DEFAULT (date('now'))
        );

        CREATE TABLE IF NOT EXISTS job_lines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL REFERENCES job_cards(id),
            inventory_item_id INTEGER,
            line_type TEXT NOT NULL,
            description TEXT,
            qty REAL DEFAULT 1,
            unit_price REAL DEFAULT 0,
            inventory_stock_qty_applied REAL NOT NULL DEFAULT 0,
            line_status TEXT NOT NULL DEFAULT 'confirmed'
        );

        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER REFERENCES job_cards(id),
            invoice_number TEXT,
            date_issued TEXT DEFAULT (date('now')),
            due_date TEXT,
            status TEXT DEFAULT 'Unpaid',
            payment_method TEXT,
            paid_amount REAL NOT NULL DEFAULT 0,
            notes TEXT,
            vat_rate REAL DEFAULT 20.0
        );

        CREATE TABLE IF NOT EXISTS bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id INTEGER REFERENCES clients(id),
            vehicle_id INTEGER REFERENCES vehicles(id),
            date TEXT,
            time TEXT,
            reason TEXT,
            status TEXT DEFAULT 'Pending',
            notes TEXT
        );

        CREATE TABLE IF NOT EXISTS inventory_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            part_name TEXT NOT NULL,
            sku TEXT,
            category TEXT,
            supplier TEXT,
            quantity REAL NOT NULL DEFAULT 0,
            minimum_stock_level REAL NOT NULL DEFAULT 0,
            purchase_cost REAL NOT NULL DEFAULT 0,
            sell_price REAL NOT NULL DEFAULT 0,
            margin_percent REAL NOT NULL DEFAULT 0,
            price_mode TEXT NOT NULL DEFAULT 'auto',
            notes TEXT
        );

        CREATE TABLE IF NOT EXISTS inventory_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
            movement_type TEXT NOT NULL,
            quantity REAL NOT NULL DEFAULT 0,
            movement_date TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
            notes TEXT
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            garage_name TEXT NOT NULL DEFAULT 'Garage CRM',
            garage_address TEXT NOT NULL DEFAULT '',
            garage_phone TEXT NOT NULL DEFAULT '',
            garage_email TEXT NOT NULL DEFAULT '',
            garage_website TEXT NOT NULL DEFAULT '',
            vat_number TEXT NOT NULL DEFAULT '',
            company_number TEXT NOT NULL DEFAULT '',
            bank_details TEXT NOT NULL DEFAULT '',
            payment_terms TEXT NOT NULL DEFAULT '',
            language TEXT NOT NULL DEFAULT 'en',
            distance_unit TEXT NOT NULL DEFAULT 'mi',
            currency TEXT NOT NULL DEFAULT 'GBP',
            vat_enabled INTEGER NOT NULL DEFAULT 1,
            default_vat_rate REAL NOT NULL DEFAULT 20.0,
            booking_slot_interval INTEGER NOT NULL DEFAULT 60,
            allow_past_booking_times INTEGER NOT NULL DEFAULT 0,
            inventory_enabled INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS cloud_session (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            account_email TEXT NOT NULL DEFAULT '',
            user_id TEXT NOT NULL DEFAULT '',
            access_token TEXT NOT NULL DEFAULT '',
            refresh_token TEXT NOT NULL DEFAULT '',
            last_synced_at TEXT NOT NULL DEFAULT '',
            session_expires_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS message_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            sms_enabled INTEGER NOT NULL DEFAULT 0,
            auto_booking_sms INTEGER NOT NULL DEFAULT 0,
            auto_job_completed_sms INTEGER NOT NULL DEFAULT 0,
            manual_sms_enabled INTEGER NOT NULL DEFAULT 1,
            booking_reminders_enabled INTEGER NOT NULL DEFAULT 1,
            ready_messages_enabled INTEGER NOT NULL DEFAULT 1,
            mot_reminders_enabled INTEGER NOT NULL DEFAULT 1,
            service_reminders_enabled INTEGER NOT NULL DEFAULT 1,
            reminder_30_days INTEGER NOT NULL DEFAULT 1,
            reminder_14_days INTEGER NOT NULL DEFAULT 1,
            reminder_7_days INTEGER NOT NULL DEFAULT 1,
            reminder_due_today INTEGER NOT NULL DEFAULT 1,
            automatic_reminder_time TEXT NOT NULL DEFAULT '09:00',
            booking_days_before INTEGER NOT NULL DEFAULT 1,
            mot_days_before INTEGER NOT NULL DEFAULT 30,
            service_days_before INTEGER NOT NULL DEFAULT 30,
            twilio_account_sid TEXT NOT NULL DEFAULT '',
            twilio_auth_token TEXT NOT NULL DEFAULT '',
            twilio_from_number TEXT NOT NULL DEFAULT '',
            garage_phone TEXT NOT NULL DEFAULT '',
            booking_template TEXT NOT NULL DEFAULT '',
            ready_template TEXT NOT NULL DEFAULT '',
            mot_template TEXT NOT NULL DEFAULT '',
            service_template TEXT NOT NULL DEFAULT '',
            completed_template TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS message_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel TEXT NOT NULL DEFAULT 'sms',
            category TEXT NOT NULL DEFAULT 'custom',
            customer_id INTEGER,
            vehicle_id INTEGER,
            booking_id INTEGER,
            job_card_id INTEGER,
            reminder_type TEXT NOT NULL DEFAULT '',
            reminder_stage TEXT NOT NULL DEFAULT '',
            recipient_name TEXT NOT NULL DEFAULT '',
            recipient_phone TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'Draft',
            related_type TEXT NOT NULL DEFAULT '',
            related_id INTEGER,
            error TEXT NOT NULL DEFAULT '',
            provider_message_id TEXT NOT NULL DEFAULT '',
            scheduled_for TEXT NOT NULL DEFAULT '',
            sent_at TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        );

        CREATE TABLE IF NOT EXISTS sms_reminder_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vehicle_id INTEGER,
            customer_id INTEGER,
            reminder_type TEXT NOT NULL DEFAULT '',
            due_date TEXT NOT NULL DEFAULT '',
            reminder_stage TEXT NOT NULL DEFAULT '',
            sent_at TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '',
            message_log_id INTEGER,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
            UNIQUE(vehicle_id, customer_id, reminder_type, due_date, reminder_stage)
        );
    ",
    )
    .expect("Failed to init DB");

    ensure_column_exists(
        conn,
        "clients",
        "cloud_account_email",
        "TEXT NOT NULL DEFAULT ''",
    );
    ensure_column_exists(conn, "clients", "cloud_user_id", "TEXT NOT NULL DEFAULT ''");
    ensure_column_exists(
        conn,
        "clients",
        "cloud_last_synced_at",
        "TEXT NOT NULL DEFAULT ''",
    );
    ensure_column_exists(
        conn,
        "clients",
        "cloud_sync_status",
        "TEXT NOT NULL DEFAULT 'Local only'",
    );
    ensure_column_exists(conn, "job_cards", "booking_id", "INTEGER");
    ensure_column_exists(conn, "invoices", "paid_amount", "REAL NOT NULL DEFAULT 0");
    ensure_column_exists(conn, "job_lines", "inventory_item_id", "INTEGER");
    ensure_column_exists(
        conn,
        "job_lines",
        "inventory_stock_qty_applied",
        "REAL NOT NULL DEFAULT 0",
    );
    ensure_column_exists(
        conn,
        "job_lines",
        "line_status",
        "TEXT NOT NULL DEFAULT 'confirmed'",
    );
    ensure_column_exists(
        conn,
        "app_settings",
        "garage_address",
        "TEXT NOT NULL DEFAULT ''",
    );
    ensure_column_exists(
        conn,
        "app_settings",
        "garage_phone",
        "TEXT NOT NULL DEFAULT ''",
    );
    ensure_column_exists(
        conn,
        "app_settings",
        "garage_email",
        "TEXT NOT NULL DEFAULT ''",
    );
    ensure_column_exists(
        conn,
        "app_settings",
        "garage_website",
        "TEXT NOT NULL DEFAULT ''",
    );
    ensure_column_exists(
        conn,
        "app_settings",
        "vat_number",
        "TEXT NOT NULL DEFAULT ''",
    );
    ensure_column_exists(
        conn,
        "app_settings",
        "company_number",
        "TEXT NOT NULL DEFAULT ''",
    );
    ensure_column_exists(
        conn,
        "app_settings",
        "bank_details",
        "TEXT NOT NULL DEFAULT ''",
    );
    ensure_column_exists(
        conn,
        "app_settings",
        "payment_terms",
        "TEXT NOT NULL DEFAULT ''",
    );
    ensure_column_exists(
        conn,
        "app_settings",
        "language",
        "TEXT NOT NULL DEFAULT 'en'",
    );
    ensure_column_exists(
        conn,
        "app_settings",
        "vat_enabled",
        "INTEGER NOT NULL DEFAULT 1",
    );
    ensure_column_exists(
        conn,
        "app_settings",
        "default_vat_rate",
        "REAL NOT NULL DEFAULT 20.0",
    );
    ensure_column_exists(
        conn,
        "app_settings",
        "booking_slot_interval",
        "INTEGER NOT NULL DEFAULT 60",
    );
    ensure_column_exists(
        conn,
        "app_settings",
        "allow_past_booking_times",
        "INTEGER NOT NULL DEFAULT 0",
    );
    ensure_column_exists(
        conn,
        "app_settings",
        "inventory_enabled",
        "INTEGER NOT NULL DEFAULT 0",
    );
    ensure_column_exists(
        conn,
        "app_settings",
        "supabase_url",
        "TEXT NOT NULL DEFAULT ''",
    );
    ensure_column_exists(
        conn,
        "app_settings",
        "supabase_service_role_key",
        "TEXT NOT NULL DEFAULT ''",
    );
    ensure_column_exists(
        conn,
        "cloud_session",
        "session_expires_at",
        "INTEGER NOT NULL DEFAULT 0",
    );
    ensure_column_exists(
        conn,
        "inventory_items",
        "sell_price",
        "REAL NOT NULL DEFAULT 0",
    );
    ensure_column_exists(
        conn,
        "inventory_items",
        "margin_percent",
        "REAL NOT NULL DEFAULT 0",
    );
    ensure_column_exists(
        conn,
        "inventory_items",
        "price_mode",
        "TEXT NOT NULL DEFAULT 'auto'",
    );
    ensure_column_exists(
        conn,
        "message_settings",
        "auto_booking_sms",
        "INTEGER NOT NULL DEFAULT 0",
    );
    ensure_column_exists(
        conn,
        "message_settings",
        "auto_job_completed_sms",
        "INTEGER NOT NULL DEFAULT 0",
    );
    ensure_column_exists(
        conn,
        "message_settings",
        "manual_sms_enabled",
        "INTEGER NOT NULL DEFAULT 1",
    );
    ensure_column_exists(
        conn,
        "message_settings",
        "reminder_30_days",
        "INTEGER NOT NULL DEFAULT 1",
    );
    ensure_column_exists(
        conn,
        "message_settings",
        "reminder_14_days",
        "INTEGER NOT NULL DEFAULT 1",
    );
    ensure_column_exists(
        conn,
        "message_settings",
        "reminder_7_days",
        "INTEGER NOT NULL DEFAULT 1",
    );
    ensure_column_exists(
        conn,
        "message_settings",
        "reminder_due_today",
        "INTEGER NOT NULL DEFAULT 1",
    );
    ensure_column_exists(
        conn,
        "message_settings",
        "automatic_reminder_time",
        "TEXT NOT NULL DEFAULT '09:00'",
    );
    ensure_column_exists(
        conn,
        "message_settings",
        "completed_template",
        "TEXT NOT NULL DEFAULT ''",
    );
    ensure_column_exists(
        conn,
        "message_settings",
        "booking_days_before",
        "INTEGER NOT NULL DEFAULT 1",
    );
    ensure_column_exists(
        conn,
        "message_settings",
        "service_reminders_enabled",
        "INTEGER NOT NULL DEFAULT 1",
    );
    ensure_column_exists(conn, "message_log", "customer_id", "INTEGER");
    ensure_column_exists(conn, "message_log", "vehicle_id", "INTEGER");
    ensure_column_exists(conn, "message_log", "booking_id", "INTEGER");
    ensure_column_exists(conn, "message_log", "job_card_id", "INTEGER");
    ensure_column_exists(
        conn,
        "message_log",
        "reminder_type",
        "TEXT NOT NULL DEFAULT ''",
    );
    ensure_column_exists(
        conn,
        "message_log",
        "reminder_stage",
        "TEXT NOT NULL DEFAULT ''",
    );
    ensure_column_exists(
        conn,
        "message_log",
        "provider_message_id",
        "TEXT NOT NULL DEFAULT ''",
    );
    ensure_column_exists(
        conn,
        "message_log",
        "scheduled_for",
        "TEXT NOT NULL DEFAULT ''",
    );

    conn.execute(
        "INSERT OR IGNORE INTO app_settings (id, garage_name, garage_address, garage_phone, garage_email, garage_website, vat_number, company_number, bank_details, payment_terms, language, distance_unit, currency, vat_enabled, default_vat_rate, booking_slot_interval, allow_past_booking_times, inventory_enabled, supabase_url, supabase_service_role_key)
         VALUES (1, 'Garage CRM', '', '', '', '', '', '', '', '', 'en', 'mi', 'GBP', 1, 20.0, 60, 0, 0, '', '')",
        [],
    )
    .expect("Failed to seed app settings");

    conn.execute(
        "INSERT OR IGNORE INTO cloud_session (id, account_email, user_id, access_token, refresh_token, last_synced_at, session_expires_at)
         VALUES (1, '', '', '', '', '', 0)",
        [],
    )
    .expect("Failed to seed cloud session");

    conn.execute(
        "INSERT OR IGNORE INTO message_settings (id, sms_enabled, auto_booking_sms, auto_job_completed_sms, manual_sms_enabled, booking_reminders_enabled, ready_messages_enabled, mot_reminders_enabled, service_reminders_enabled, reminder_30_days, reminder_14_days, reminder_7_days, reminder_due_today, automatic_reminder_time, booking_days_before, mot_days_before, service_days_before, twilio_account_sid, twilio_auth_token, twilio_from_number, garage_phone, booking_template, ready_template, mot_template, service_template, completed_template)
         VALUES (1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, '09:00', 1, 30, 30, '', '', '', '', ?1, ?2, ?3, ?4, ?5)",
        params![
            default_booking_message_template(),
            default_ready_message_template(),
            default_mot_message_template(),
            default_service_message_template(),
            default_completed_message_template()
        ],
    )
    .expect("Failed to seed message settings");

    conn.execute(
        "UPDATE vehicles
         SET mileage=(
           SELECT MAX(jc.mileage_in)
           FROM job_cards jc
           WHERE jc.vehicle_id=vehicles.id AND COALESCE(jc.mileage_in, 0) > 0
         )
         WHERE COALESCE(mileage, 0) <= 0
           AND EXISTS (
             SELECT 1 FROM job_cards jc
             WHERE jc.vehicle_id=vehicles.id AND COALESCE(jc.mileage_in, 0) > 0
           )",
        [],
    )
    .expect("Failed to backfill vehicle mileage from job cards");

    conn.execute(
        "UPDATE job_cards
         SET mileage_in=(
           SELECT v.mileage FROM vehicles v WHERE v.id=job_cards.vehicle_id
         )
         WHERE COALESCE(mileage_in, 0) <= 0
           AND COALESCE((SELECT v.mileage FROM vehicles v WHERE v.id=job_cards.vehicle_id), 0) > 0",
        [],
    )
    .expect("Failed to backfill job card mileage from vehicles");

    conn.execute(
        "UPDATE message_settings SET twilio_account_sid='', twilio_auth_token='', twilio_from_number='' WHERE id=1",
        [],
    )
    .expect("Failed to clear legacy Twilio settings");
}

fn ensure_column_exists(conn: &Connection, table: &str, column: &str, definition: &str) {
    let pragma = format!("PRAGMA table_info({})", table);
    let mut stmt = conn.prepare(&pragma).expect("Failed to inspect table");
    let exists = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .expect("Failed to query table info")
        .filter_map(Result::ok)
        .any(|name| name == column);

    if !exists {
        conn.execute(
            &format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, definition),
            [],
        )
        .unwrap_or_else(|_| panic!("Failed to add column {}.{}", table, column));
    }
}

fn normalize_job_line_status(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "pending" => "pending".to_string(),
        _ => "confirmed".to_string(),
    }
}

fn sanitize_app_settings(settings: AppSettings) -> AppSettings {
    let garage_name = {
        let trimmed = settings.garage_name.trim();
        if trimmed.is_empty() {
            "Garage CRM".to_string()
        } else {
            trimmed.to_string()
        }
    };
    let clean_text = |value: &str, max_len: usize| -> String {
        value.trim().chars().take(max_len).collect::<String>()
    };
    let garage_address = clean_text(&settings.garage_address, 800);
    let garage_phone = clean_text(&settings.garage_phone, 80);
    let garage_email = clean_text(&settings.garage_email, 120);
    let garage_website = clean_text(&settings.garage_website, 160);
    let vat_number = clean_text(&settings.vat_number, 80);
    let company_number = clean_text(&settings.company_number, 80);
    let bank_details = clean_text(&settings.bank_details, 1000);
    let payment_terms = clean_text(&settings.payment_terms, 1000);
    let language = match settings.language.trim().to_ascii_lowercase().as_str() {
        "ru" => "ru".to_string(),
        "bg" => "bg".to_string(),
        _ => "en".to_string(),
    };

    let distance_unit = if settings.distance_unit.eq_ignore_ascii_case("km") {
        "km".to_string()
    } else {
        "mi".to_string()
    };

    let currency = {
        let code = settings.currency.trim().to_ascii_uppercase();
        if code.len() == 3 && code.chars().all(|ch| ch.is_ascii_alphabetic()) {
            code
        } else {
            "GBP".to_string()
        }
    };

    let booking_slot_interval = if settings.booking_slot_interval == 30 {
        30
    } else {
        60
    };
    let vat_enabled = settings.vat_enabled;
    let default_vat_rate = if settings.default_vat_rate.is_finite() {
        settings.default_vat_rate.clamp(0.0, 100.0)
    } else {
        default_vat_rate()
    };
    let default_vat_rate = (default_vat_rate * 100.0).round() / 100.0;
    let allow_past_booking_times = settings.allow_past_booking_times;
    let inventory_enabled = settings.inventory_enabled;

    let supabase_url = settings
        .supabase_url
        .trim()
        .trim_end_matches('/')
        .to_string();
    let supabase_service_role_key = String::new();

    AppSettings {
        garage_name,
        garage_address,
        garage_phone,
        garage_email,
        garage_website,
        vat_number,
        company_number,
        bank_details,
        payment_terms,
        language,
        distance_unit,
        currency,
        vat_enabled,
        default_vat_rate,
        booking_slot_interval,
        allow_past_booking_times,
        inventory_enabled,
        supabase_url,
        supabase_service_role_key,
    }
}

fn vehicle_belongs_to_client(
    conn: &Connection,
    vehicle_id: i64,
    client_id: i64,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM vehicles WHERE id=?1 AND client_id=?2",
        params![vehicle_id, client_id],
        |r| r.get::<_, i64>(0),
    )
    .map(|count| count > 0)
    .map_err(|e| e.to_string())
}

fn ensure_vehicle_belongs_to_client(
    conn: &Connection,
    vehicle_id: i64,
    client_id: i64,
) -> Result<(), String> {
    if vehicle_belongs_to_client(conn, vehicle_id, client_id)? {
        Ok(())
    } else {
        Err("Selected vehicle belongs to a different client.".to_string())
    }
}

fn get_vehicle_mileage(conn: &Connection, vehicle_id: i64) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(mileage, 0) FROM vehicles WHERE id=?1",
        params![vehicle_id],
        |r| r.get::<_, i64>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|mileage| mileage.unwrap_or(0))
}

fn is_open_job_status(status: &str) -> bool {
    !matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "completed" | "cancelled"
    )
}

fn normalize_job_mileage_from_vehicle(conn: &Connection, job: &mut JobCard) -> Result<(), String> {
    if job.mileage_in > 0 {
        return Ok(());
    }
    let vehicle_mileage = get_vehicle_mileage(conn, job.vehicle_id)?;
    if vehicle_mileage > 0 {
        job.mileage_in = vehicle_mileage;
    }
    Ok(())
}

fn sync_vehicle_mileage_from_job(
    conn: &Connection,
    vehicle_id: i64,
    mileage: i64,
    job_status: &str,
) -> Result<(), String> {
    if mileage <= 0 {
        return Ok(());
    }
    let current_mileage = get_vehicle_mileage(conn, vehicle_id)?;
    if is_open_job_status(job_status) || current_mileage <= 0 || mileage >= current_mileage {
        conn.execute(
            "UPDATE vehicles SET mileage=?1 WHERE id=?2",
            params![mileage, vehicle_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn sync_job_cards_mileage_from_vehicle(
    conn: &Connection,
    vehicle_id: i64,
    mileage: i64,
) -> Result<(), String> {
    if mileage <= 0 {
        return Ok(());
    }
    conn.execute(
        "UPDATE job_cards
         SET mileage_in=?1
         WHERE vehicle_id=?2
           AND (COALESCE(mileage_in, 0) <= 0 OR LOWER(COALESCE(status, '')) NOT IN ('completed', 'cancelled'))",
        params![mileage, vehicle_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn default_app_settings() -> AppSettings {
    AppSettings {
        garage_name: "Garage CRM".to_string(),
        garage_address: String::new(),
        garage_phone: String::new(),
        garage_email: String::new(),
        garage_website: String::new(),
        vat_number: String::new(),
        company_number: String::new(),
        bank_details: String::new(),
        payment_terms: String::new(),
        language: default_language(),
        distance_unit: "mi".to_string(),
        currency: "GBP".to_string(),
        vat_enabled: default_vat_enabled(),
        default_vat_rate: default_vat_rate(),
        booking_slot_interval: default_booking_slot_interval(),
        allow_past_booking_times: default_allow_past_booking_times(),
        inventory_enabled: false,
        supabase_url: String::new(),
        supabase_service_role_key: String::new(),
    }
}

fn load_app_settings_from_conn(conn: &Connection) -> AppSettings {
    let settings = conn
        .query_row(
            "SELECT garage_name, garage_address, garage_phone, garage_email, garage_website, vat_number, company_number, bank_details, payment_terms, language, distance_unit, currency, vat_enabled, default_vat_rate, booking_slot_interval, allow_past_booking_times, inventory_enabled, supabase_url, supabase_service_role_key FROM app_settings WHERE id=1",
            [],
            |r| {
                Ok(AppSettings {
                    garage_name: r.get::<_, String>(0)?,
                    garage_address: r.get::<_, String>(1).unwrap_or_default(),
                    garage_phone: r.get::<_, String>(2).unwrap_or_default(),
                    garage_email: r.get::<_, String>(3).unwrap_or_default(),
                    garage_website: r.get::<_, String>(4).unwrap_or_default(),
                    vat_number: r.get::<_, String>(5).unwrap_or_default(),
                    company_number: r.get::<_, String>(6).unwrap_or_default(),
                    bank_details: r.get::<_, String>(7).unwrap_or_default(),
                    payment_terms: r.get::<_, String>(8).unwrap_or_default(),
                    language: r.get::<_, String>(9).unwrap_or_else(|_| default_language()),
                    distance_unit: r.get::<_, String>(10)?,
                    currency: r.get::<_, String>(11)?,
                    vat_enabled: r.get::<_, bool>(12).unwrap_or_else(|_| default_vat_enabled()),
                    default_vat_rate: r.get::<_, f64>(13).unwrap_or_else(|_| default_vat_rate()),
                    booking_slot_interval: r.get::<_, i64>(14).unwrap_or_else(|_| default_booking_slot_interval()),
                    allow_past_booking_times: r.get::<_, bool>(15).unwrap_or_else(|_| default_allow_past_booking_times()),
                    inventory_enabled: r.get::<_, bool>(16).unwrap_or(false),
                    supabase_url: r.get::<_, String>(17).unwrap_or_default(),
                    supabase_service_role_key: r.get::<_, String>(18).unwrap_or_default(),
                })
            },
        )
        .unwrap_or_else(|_| default_app_settings());

    sanitize_app_settings(settings)
}

fn sanitize_message_text(value: &str, fallback: String) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback
    } else {
        trimmed.to_string()
    }
}

fn sanitize_phone_for_sms(value: &str) -> String {
    let raw = value.trim();
    if raw.is_empty() {
        return String::new();
    }
    let mut phone: String = raw
        .chars()
        .filter(|ch| ch.is_ascii_digit() || *ch == '+')
        .collect();
    if phone.starts_with("00") {
        phone = format!("+{}", &phone[2..]);
    }
    if phone.starts_with('0') {
        phone = format!("+44{}", &phone[1..]);
    }
    if !phone.starts_with('+') && phone.len() >= 10 {
        phone = format!("+{}", phone);
    }
    phone
}

fn sanitize_message_category(value: &str) -> String {
    match value.trim() {
        "booking_confirmation" => "booking_confirmation".to_string(),
        "booking_reminder" => "booking_reminder".to_string(),
        "job_completed" => "job_completed".to_string(),
        "ready_collection" => "ready_collection".to_string(),
        "mot_reminder" => "mot_reminder".to_string(),
        "service_reminder" => "service_reminder".to_string(),
        _ => "custom".to_string(),
    }
}

fn clamp_message_lead_days(value: i64, fallback: i64) -> i64 {
    if value < 0 {
        fallback
    } else {
        value.min(365)
    }
}

fn sanitize_reminder_time(value: &str) -> String {
    let mut parts = value.trim().split(':');
    let hours = parts.next().and_then(|part| part.parse::<u32>().ok());
    let minutes = parts.next().and_then(|part| part.parse::<u32>().ok());
    if parts.next().is_none() {
        if let (Some(hours), Some(minutes)) = (hours, minutes) {
            if hours < 24 && minutes < 60 {
                return format!("{:02}:{:02}", hours, minutes);
            }
        }
    }
    default_automatic_reminder_time()
}

fn sanitize_message_settings(settings: MessageSettings) -> MessageSettings {
    MessageSettings {
        sms_enabled: settings.sms_enabled,
        auto_booking_sms: settings.auto_booking_sms,
        auto_job_completed_sms: settings.auto_job_completed_sms,
        manual_sms_enabled: settings.manual_sms_enabled,
        booking_reminders_enabled: settings.booking_reminders_enabled,
        ready_messages_enabled: settings.ready_messages_enabled,
        mot_reminders_enabled: settings.mot_reminders_enabled,
        service_reminders_enabled: settings.service_reminders_enabled,
        automatic_reminder_time: sanitize_reminder_time(&settings.automatic_reminder_time),
        booking_days_before: clamp_message_lead_days(
            settings.booking_days_before,
            default_booking_message_lead_days(),
        ),
        mot_days_before: clamp_message_lead_days(
            settings.mot_days_before,
            default_message_lead_days(),
        ),
        service_days_before: clamp_message_lead_days(
            settings.service_days_before,
            default_message_lead_days(),
        ),
        garage_phone: settings.garage_phone.trim().to_string(),
        booking_template: sanitize_message_text(
            &settings.booking_template,
            default_booking_message_template(),
        ),
        ready_template: sanitize_message_text(
            &settings.ready_template,
            default_ready_message_template(),
        ),
        mot_template: sanitize_message_text(&settings.mot_template, default_mot_message_template()),
        service_template: sanitize_message_text(
            &settings.service_template,
            default_service_message_template(),
        ),
        completed_template: sanitize_message_text(
            &settings.completed_template,
            default_completed_message_template(),
        ),
        reminder_30_days: settings.reminder_30_days,
        reminder_14_days: settings.reminder_14_days,
        reminder_7_days: settings.reminder_7_days,
        reminder_due_today: settings.reminder_due_today,
    }
}

fn default_message_settings() -> MessageSettings {
    MessageSettings {
        sms_enabled: false,
        auto_booking_sms: false,
        auto_job_completed_sms: false,
        manual_sms_enabled: true,
        booking_reminders_enabled: true,
        ready_messages_enabled: true,
        mot_reminders_enabled: true,
        service_reminders_enabled: true,
        automatic_reminder_time: default_automatic_reminder_time(),
        booking_days_before: default_booking_message_lead_days(),
        mot_days_before: default_message_lead_days(),
        service_days_before: default_message_lead_days(),
        garage_phone: String::new(),
        booking_template: default_booking_message_template(),
        ready_template: default_ready_message_template(),
        mot_template: default_mot_message_template(),
        service_template: default_service_message_template(),
        completed_template: default_completed_message_template(),
        reminder_30_days: true,
        reminder_14_days: true,
        reminder_7_days: true,
        reminder_due_today: true,
    }
}

fn load_message_settings_from_conn(conn: &Connection) -> MessageSettings {
    let settings = conn
        .query_row(
            "SELECT sms_enabled, auto_booking_sms, auto_job_completed_sms, manual_sms_enabled, booking_reminders_enabled, ready_messages_enabled, mot_reminders_enabled, service_reminders_enabled, automatic_reminder_time, booking_days_before, mot_days_before, service_days_before, garage_phone, booking_template, ready_template, mot_template, service_template, completed_template, reminder_30_days, reminder_14_days, reminder_7_days, reminder_due_today FROM message_settings WHERE id=1",
            [],
            |r| {
                Ok(MessageSettings {
                    sms_enabled: r.get::<_, bool>(0).unwrap_or(false),
                    auto_booking_sms: r.get::<_, bool>(1).unwrap_or(false),
                    auto_job_completed_sms: r.get::<_, bool>(2).unwrap_or(false),
                    manual_sms_enabled: r.get::<_, bool>(3).unwrap_or(true),
                    booking_reminders_enabled: r.get::<_, bool>(4).unwrap_or(true),
                    ready_messages_enabled: r.get::<_, bool>(5).unwrap_or(true),
                    mot_reminders_enabled: r.get::<_, bool>(6).unwrap_or(true),
                    service_reminders_enabled: r.get::<_, bool>(7).unwrap_or(true),
                    automatic_reminder_time: r.get::<_, String>(8).unwrap_or_else(|_| default_automatic_reminder_time()),
                    booking_days_before: r.get::<_, i64>(9).unwrap_or_else(|_| default_booking_message_lead_days()),
                    mot_days_before: r.get::<_, i64>(10).unwrap_or_else(|_| default_message_lead_days()),
                    service_days_before: r.get::<_, i64>(11).unwrap_or_else(|_| default_message_lead_days()),
                    garage_phone: r.get::<_, String>(12).unwrap_or_default(),
                    booking_template: r.get::<_, String>(13).unwrap_or_else(|_| default_booking_message_template()),
                    ready_template: r.get::<_, String>(14).unwrap_or_else(|_| default_ready_message_template()),
                    mot_template: r.get::<_, String>(15).unwrap_or_else(|_| default_mot_message_template()),
                    service_template: r.get::<_, String>(16).unwrap_or_else(|_| default_service_message_template()),
                    completed_template: r.get::<_, String>(17).unwrap_or_else(|_| default_completed_message_template()),
                    reminder_30_days: r.get::<_, bool>(18).unwrap_or(true),
                    reminder_14_days: r.get::<_, bool>(19).unwrap_or(true),
                    reminder_7_days: r.get::<_, bool>(20).unwrap_or(true),
                    reminder_due_today: r.get::<_, bool>(21).unwrap_or(true),
                })
            },
        )
        .unwrap_or_else(|_| default_message_settings());
    sanitize_message_settings(settings)
}

fn current_timestamp_iso(conn: &Connection) -> String {
    conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now')", [], |r| {
        r.get::<_, String>(0)
    })
    .unwrap_or_default()
}

fn sanitize_stock_number(value: f64) -> f64 {
    if value.is_finite() {
        ((value.max(0.0)) * 100.0).round() / 100.0
    } else {
        0.0
    }
}

fn sanitize_stock_delta(value: f64) -> f64 {
    if value.is_finite() {
        (value * 100.0).round() / 100.0
    } else {
        0.0
    }
}

fn sanitize_margin_percent(value: f64) -> f64 {
    if value.is_finite() {
        (value.clamp(0.0, 1000.0) * 100.0).round() / 100.0
    } else {
        0.0
    }
}

fn normalize_inventory_price_mode(value: &str) -> String {
    if value.trim().eq_ignore_ascii_case("manual") {
        "manual".to_string()
    } else {
        "auto".to_string()
    }
}

fn calculate_inventory_sell_price(purchase_cost: f64, margin_percent: f64) -> f64 {
    sanitize_stock_number(purchase_cost * (1.0 + (margin_percent / 100.0)))
}

fn calculate_inventory_margin_percent(purchase_cost: f64, sell_price: f64) -> f64 {
    if purchase_cost > f64::EPSILON {
        sanitize_margin_percent(((sell_price - purchase_cost) / purchase_cost) * 100.0)
    } else {
        0.0
    }
}

fn resolve_inventory_pricing(
    purchase_cost: f64,
    sell_price: f64,
    margin_percent: f64,
    price_mode: &str,
) -> (f64, f64, String) {
    let purchase_cost = sanitize_stock_number(purchase_cost);
    let price_mode = normalize_inventory_price_mode(price_mode);
    if price_mode == "manual" {
        let sell_price = sanitize_stock_number(sell_price);
        (
            sell_price,
            calculate_inventory_margin_percent(purchase_cost, sell_price),
            price_mode,
        )
    } else {
        let margin_percent = sanitize_margin_percent(margin_percent);
        (
            calculate_inventory_sell_price(purchase_cost, margin_percent),
            margin_percent,
            price_mode,
        )
    }
}

fn normalize_inventory_movement_type(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase().replace('_', " ");
    match normalized.as_str() {
        "stock out" | "out" | "remove" | "removed" => "Stock Out".to_string(),
        "adjustment" | "adjust" => "Adjustment".to_string(),
        _ => "Stock In".to_string(),
    }
}

fn insert_inventory_movement(
    conn: &Connection,
    inventory_item_id: i64,
    movement_type: &str,
    quantity: f64,
    notes: &str,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO inventory_movements (inventory_item_id, movement_type, quantity, movement_date, notes)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            inventory_item_id,
            normalize_inventory_movement_type(movement_type),
            sanitize_stock_delta(quantity),
            current_timestamp_iso(conn),
            notes.trim()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

fn apply_job_line_inventory_delta(
    conn: &Connection,
    inventory_item_id: Option<i64>,
    delta_reserved_qty: f64,
    note: &str,
) -> Result<(), String> {
    let Some(item_id) = inventory_item_id.filter(|id| *id > 0) else {
        return Ok(());
    };
    let delta = sanitize_stock_delta(delta_reserved_qty);
    if delta.abs() <= f64::EPSILON {
        return Ok(());
    }
    let current_quantity = conn
        .query_row(
            "SELECT quantity FROM inventory_items WHERE id=?1",
            params![item_id],
            |r| r.get::<_, f64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Inventory item not found.".to_string())?;
    let next_quantity = sanitize_stock_delta(current_quantity - delta);
    if next_quantity < 0.0 {
        return Err("Not enough inventory quantity for this job line.".to_string());
    }
    conn.execute(
        "UPDATE inventory_items SET quantity=?1 WHERE id=?2",
        params![next_quantity, item_id],
    )
    .map_err(|e| e.to_string())?;
    let movement_type = if delta > 0.0 { "Stock Out" } else { "Stock In" };
    insert_inventory_movement(conn, item_id, movement_type, delta.abs(), note)?;
    Ok(())
}

fn load_cloud_build_config() -> CloudBuildConfig {
    let baked_url = option_env!("GARAGE_CRM_SUPABASE_URL")
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/')
        .to_string();
    let baked_key = option_env!("GARAGE_CRM_SUPABASE_ANON_KEY")
        .unwrap_or_default()
        .trim()
        .to_string();

    CloudBuildConfig {
        supabase_url: if baked_url.is_empty() {
            env::var("VITE_SUPABASE_URL")
                .or_else(|_| env::var("GARAGE_CRM_SUPABASE_URL"))
                .unwrap_or_default()
                .trim()
                .trim_end_matches('/')
                .to_string()
        } else {
            baked_url
        },
        supabase_anon_key: if baked_key.is_empty() {
            env::var("VITE_SUPABASE_ANON_KEY")
                .or_else(|_| env::var("GARAGE_CRM_SUPABASE_ANON_KEY"))
                .unwrap_or_default()
                .trim()
                .to_string()
        } else {
            baked_key
        },
    }
}

fn load_updater_pubkey_from_env() -> String {
    let inline = env::var("GARAGE_CRM_UPDATER_PUBKEY")
        .unwrap_or_default()
        .trim()
        .replace("\\n", "\n")
        .to_string();
    if !inline.is_empty() {
        return inline;
    }

    let path = env::var("GARAGE_CRM_UPDATER_PUBKEY_PATH")
        .unwrap_or_default()
        .trim()
        .to_string();
    if path.is_empty() {
        return String::new();
    }

    fs::read_to_string(path)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn load_updater_build_config() -> UpdaterBuildConfig {
    let baked_endpoint = option_env!("GARAGE_CRM_UPDATER_ENDPOINT")
        .unwrap_or_default()
        .trim()
        .to_string();
    let baked_pubkey = option_env!("GARAGE_CRM_UPDATER_PUBKEY")
        .unwrap_or_default()
        .trim()
        .replace("\\n", "\n")
        .to_string();

    UpdaterBuildConfig {
        endpoint: if baked_endpoint.is_empty() {
            env::var("GARAGE_CRM_UPDATER_ENDPOINT")
                .unwrap_or_default()
                .trim()
                .to_string()
        } else {
            baked_endpoint
        },
        pubkey: if baked_pubkey.is_empty() {
            load_updater_pubkey_from_env()
        } else {
            baked_pubkey
        },
    }
}

fn updater_is_configured(config: &UpdaterBuildConfig) -> bool {
    !config.endpoint.is_empty() && !config.pubkey.is_empty()
}

fn build_app_updater(app: &tauri::AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let config = load_updater_build_config();
    if updater_is_configured(&config) {
        let endpoint = Url::parse(&config.endpoint)
            .map_err(|e| format!("Updater endpoint is invalid: {}", e))?;
        app.updater_builder()
            .pubkey(config.pubkey)
            .endpoints(vec![endpoint])
            .map_err(|e| e.to_string())?
            .build()
            .map_err(|e| e.to_string())
    } else {
        app.updater().map_err(|e| e.to_string())
    }
}

fn load_cloud_config_from_settings(settings: Option<&AppSettings>) -> CloudBuildConfig {
    let mut config = load_cloud_build_config();
    if config.supabase_url.is_empty() {
        config.supabase_url = settings
            .map(|s| s.supabase_url.trim().trim_end_matches('/').to_string())
            .unwrap_or_default();
    }
    config
}

fn cloud_is_configured(settings: Option<&AppSettings>) -> bool {
    let config = load_cloud_config_from_settings(settings);
    !config.supabase_url.is_empty() && !config.supabase_anon_key.is_empty()
}

fn ensure_cloud_configured(settings: Option<&AppSettings>) -> Result<CloudBuildConfig, String> {
    let config = load_cloud_config_from_settings(settings);
    if !config.supabase_url.is_empty() && !config.supabase_anon_key.is_empty() {
        Ok(config)
    } else {
        Err("Account login is not available in this build yet. Contact support.".to_string())
    }
}

fn unix_timestamp_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn next_cloud_access_token_expiry(expires_in: Option<i64>) -> i64 {
    let ttl = expires_in
        .filter(|seconds| *seconds > 0)
        .unwrap_or(DEFAULT_CLOUD_ACCESS_TOKEN_SECONDS);
    unix_timestamp_seconds() + ttl
}

fn cloud_session_expiry_from_auth_response(response_json: &Value) -> i64 {
    let now = unix_timestamp_seconds();
    let expires_at = response_json
        .get("expires_at")
        .and_then(Value::as_i64)
        .filter(|value| *value > now);
    let expires_in = response_json.get("expires_in").and_then(Value::as_i64);
    expires_at.unwrap_or_else(|| next_cloud_access_token_expiry(expires_in))
}

fn cloud_session_expiry_from_payload(session: &SupabaseAuthSessionPayload) -> i64 {
    let now = unix_timestamp_seconds();
    session
        .expires_at
        .filter(|value| *value > now)
        .unwrap_or_else(|| next_cloud_access_token_expiry(session.expires_in))
}

fn cloud_session_needs_refresh(session: &CloudSession) -> bool {
    if session.access_token.trim().is_empty() {
        return true;
    }
    let now = unix_timestamp_seconds();
    let expires_at = session.session_expires_at;
    expires_at <= 0
        || expires_at > now + MAX_CLOUD_ACCESS_TOKEN_SECONDS
        || expires_at <= now + CLOUD_SESSION_REFRESH_LEEWAY_SECONDS
}

fn http_client() -> HttpClient {
    match HttpClient::builder()
        .timeout(Duration::from_secs(CLOUD_HTTP_TIMEOUT_SECONDS))
        .build()
    {
        Ok(client) => client,
        Err(_) => HttpClient::new(),
    }
}

fn default_cloud_session() -> CloudSession {
    CloudSession {
        account_email: String::new(),
        user_id: String::new(),
        access_token: String::new(),
        refresh_token: String::new(),
        last_synced_at: String::new(),
        session_expires_at: 0,
    }
}

fn load_cloud_session_from_conn(conn: &Connection) -> CloudSession {
    conn.query_row(
        "SELECT account_email, user_id, access_token, refresh_token, last_synced_at, session_expires_at FROM cloud_session WHERE id=1",
        [],
        |r| {
            Ok(CloudSession {
                account_email: r.get::<_, String>(0).unwrap_or_default(),
                user_id: r.get::<_, String>(1).unwrap_or_default(),
                access_token: r.get::<_, String>(2).unwrap_or_default(),
                refresh_token: r.get::<_, String>(3).unwrap_or_default(),
                last_synced_at: r.get::<_, String>(4).unwrap_or_default(),
                session_expires_at: r.get::<_, i64>(5).unwrap_or_default(),
            })
        },
    )
    .unwrap_or_else(|_| default_cloud_session())
}

fn save_cloud_session_to_conn(conn: &Connection, session: &CloudSession) -> Result<(), String> {
    let session_expires_at =
        if session.user_id.trim().is_empty() || session.refresh_token.trim().is_empty() {
            0
        } else if session.session_expires_at > 0 {
            session.session_expires_at
        } else {
            next_cloud_access_token_expiry(None)
        };
    conn.execute(
        "INSERT INTO cloud_session (id, account_email, user_id, access_token, refresh_token, last_synced_at, session_expires_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
            account_email=excluded.account_email,
            user_id=excluded.user_id,
            access_token=excluded.access_token,
            refresh_token=excluded.refresh_token,
            last_synced_at=excluded.last_synced_at,
            session_expires_at=excluded.session_expires_at",
        params![
            &session.account_email,
            &session.user_id,
            &session.access_token,
            &session.refresh_token,
            &session.last_synced_at,
            session_expires_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn clear_cloud_session_in_conn(conn: &Connection) -> Result<(), String> {
    save_cloud_session_to_conn(conn, &default_cloud_session())
}

fn cloud_session_is_remembered(session: &CloudSession) -> bool {
    !session.user_id.trim().is_empty() && !session.refresh_token.trim().is_empty()
}

fn load_remembered_cloud_session_from_conn(conn: &Connection) -> CloudSession {
    let session = load_cloud_session_from_conn(conn);
    if cloud_session_is_remembered(&session) {
        session
    } else {
        if !session.user_id.trim().is_empty() || !session.refresh_token.trim().is_empty() {
            let _ = clear_cloud_session_in_conn(conn);
        }
        default_cloud_session()
    }
}

fn empty_account_snapshot() -> Value {
    json!({
        "garage": {
            "garage_name": "Garage CRM",
            "garage_address": "",
            "garage_phone": "",
            "garage_email": "",
            "garage_website": "",
            "vat_number": "",
            "company_number": "",
            "bank_details": "",
            "payment_terms": "",
            "language": "en",
            "distance_unit": "mi",
            "currency": "GBP",
            "vat_enabled": true,
            "default_vat_rate": 20.0,
            "booking_slot_interval": 60,
            "allow_past_booking_times": false,
            "inventory_enabled": false
        },
        "clients": [],
        "vehicles": [],
        "job_cards": [],
        "job_lines": [],
        "invoices": [],
        "bookings": [],
        "message_log": [],
        "sms_reminder_history": [],
        "synced_at": ""
    })
}

fn clear_local_account_data(conn: &Connection) -> Result<(), String> {
    apply_account_snapshot(conn, &empty_account_snapshot())?;
    conn.execute(
        "UPDATE message_settings SET sms_enabled=0, twilio_account_sid='', twilio_auth_token='', twilio_from_number='' WHERE id=1",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn reset_local_data_for_account_switch(
    conn: &Connection,
    next_user_id: &str,
) -> Result<(), String> {
    let current = load_cloud_session_from_conn(conn);
    if current.user_id.trim() == next_user_id.trim() {
        return Ok(());
    }
    clear_local_account_data(conn)
}

fn cloud_account_status_from_session(
    session: &CloudSession,
    settings: Option<&AppSettings>,
) -> CloudAccountStatus {
    CloudAccountStatus {
        configured: cloud_is_configured(settings),
        account_email: session.account_email.clone(),
        user_id: session.user_id.clone(),
        last_synced_at: session.last_synced_at.clone(),
    }
}

fn user_identity_from_auth_response(response_json: &Value) -> Result<(String, String), String> {
    let user_id = value_string(response_json, &["user", "id"])
        .or_else(|| value_string(response_json, &["id"]))
        .unwrap_or_default();
    let account_email = value_string(response_json, &["user", "email"])
        .or_else(|| value_string(response_json, &["email"]))
        .unwrap_or_default();
    if user_id.is_empty() {
        return Err("Account service did not return a user id.".to_string());
    }
    Ok((user_id, account_email))
}

fn normalize_cloud_auth_error(error: String) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("email rate limit exceeded") {
        return "Email limit reached. Wait a while before sending another email.".to_string();
    }
    if lower.contains("too many requests") {
        return "Too many requests. Wait a little and try again.".to_string();
    }
    if lower.contains("user already registered") {
        return "This login already exists. Use Login instead.".to_string();
    }
    if lower.contains("email not confirmed") {
        return "Confirm the email from the letter first, then log in.".to_string();
    }
    if lower.contains("invalid login credentials") {
        return "Wrong login or password, or the email is not confirmed yet.".to_string();
    }
    if lower.contains("signup is disabled") || lower.contains("signups not allowed") {
        return "Account creation is currently disabled.".to_string();
    }
    if lower.contains("password should be at least") || lower.contains("weak password") {
        return "Password is too weak. Use at least 8 characters.".to_string();
    }
    error
}

#[allow(dead_code)]
fn ensure_supabase_ready(settings: &AppSettings) -> Result<(), String> {
    if settings.supabase_url.is_empty() {
        Err("Account service is not configured yet.".to_string())
    } else {
        Ok(())
    }
}

fn read_error_message(body: &str) -> String {
    if body.trim().is_empty() {
        return "No response body".to_string();
    }

    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("msg")
                .and_then(Value::as_str)
                .or_else(|| value.get("message").and_then(Value::as_str))
                .or_else(|| value.get("error_description").and_then(Value::as_str))
                .or_else(|| value.get("error").and_then(Value::as_str))
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.to_string())
}

fn parse_response_json(response: reqwest::blocking::Response) -> Result<Value, String> {
    let status = response.status();
    let body = response.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "Account service returned {}: {}",
            status,
            read_error_message(&body)
        ));
    }
    serde_json::from_str::<Value>(&body).map_err(|e| e.to_string())
}

fn parse_response_json_message_only(
    response: reqwest::blocking::Response,
    fallback: &str,
) -> Result<Value, String> {
    let status = response.status();
    let body = response.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        let message = read_error_message(&body);
        if message.trim().is_empty() || message == "No response body" {
            return Err(fallback.to_string());
        }
        return Err(message);
    }
    serde_json::from_str::<Value>(&body).map_err(|e| e.to_string())
}

fn value_string(value: &Value, keys: &[&str]) -> Option<String> {
    let mut current = value;
    for key in keys {
        current = current.get(*key)?;
    }

    current.as_str().map(str::to_string)
}

fn normalize_vehicle_registration_for_lookup(registration: &str) -> String {
    registration
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_uppercase())
        .collect()
}

fn cloud_auth_headers(
    request: reqwest::blocking::RequestBuilder,
    config: &CloudBuildConfig,
) -> reqwest::blocking::RequestBuilder {
    request
        .header("apikey", &config.supabase_anon_key)
        .header("Content-Type", "application/json")
}

fn cloud_rest_headers(
    request: reqwest::blocking::RequestBuilder,
    config: &CloudBuildConfig,
    access_token: &str,
) -> reqwest::blocking::RequestBuilder {
    request
        .header("apikey", &config.supabase_anon_key)
        .bearer_auth(access_token)
        .header("Content-Type", "application/json")
}

fn session_from_auth_response(response_json: &Value) -> Result<CloudSession, String> {
    let access_token = value_string(response_json, &["access_token"]).unwrap_or_default();
    let refresh_token = value_string(response_json, &["refresh_token"]).unwrap_or_default();
    let user_id = value_string(response_json, &["user", "id"])
        .or_else(|| value_string(response_json, &["id"]))
        .unwrap_or_default();
    let account_email = value_string(response_json, &["user", "email"])
        .or_else(|| value_string(response_json, &["email"]))
        .unwrap_or_default();

    if user_id.is_empty() {
        return Err("Account service did not return a user id.".to_string());
    }
    if access_token.is_empty() || refresh_token.is_empty() {
        return Err(
            "Account service did not return a session. Confirm the email before signing in."
                .to_string(),
        );
    }

    Ok(CloudSession {
        account_email,
        user_id,
        access_token,
        refresh_token,
        last_synced_at: String::new(),
        session_expires_at: cloud_session_expiry_from_auth_response(response_json),
    })
}

fn refresh_cloud_session(
    session: &CloudSession,
    settings: Option<&AppSettings>,
) -> Result<CloudSession, String> {
    let config = ensure_cloud_configured(settings)?;
    if session.refresh_token.trim().is_empty() {
        return Err("No refresh token saved. Sign in again.".to_string());
    }

    let response = cloud_auth_headers(
        http_client().post(format!(
            "{}/auth/v1/token?grant_type=refresh_token",
            config.supabase_url
        )),
        &config,
    )
    .json(&json!({ "refresh_token": session.refresh_token }))
    .send()
    .map_err(|e| format!("Failed to reach account service: {}", e))?;
    let response_json = parse_response_json(response)?;
    let mut next_session = session_from_auth_response(&response_json)?;
    next_session.last_synced_at = session.last_synced_at.clone();
    Ok(next_session)
}

fn ensure_active_cloud_session(conn: &Connection) -> Result<CloudSession, String> {
    let settings = load_app_settings_from_conn(conn);
    ensure_cloud_configured(Some(&settings))?;
    let current = load_remembered_cloud_session_from_conn(conn);
    if current.user_id.trim().is_empty() || current.refresh_token.trim().is_empty() {
        return Err("Create or sign in to a cloud account first.".to_string());
    }

    if !cloud_session_needs_refresh(&current) {
        return Ok(current);
    }

    if !current.refresh_token.trim().is_empty() {
        match refresh_cloud_session(&current, Some(&settings)) {
            Ok(refreshed) => {
                save_cloud_session_to_conn(conn, &refreshed)?;
                return Ok(refreshed);
            }
            Err(_) if !current.access_token.trim().is_empty() => {
                return Ok(current);
            }
            Err(error) => return Err(error),
        }
    }

    Ok(current)
}

#[allow(dead_code)]
fn upsert_client_cloud_status(
    conn: &Connection,
    client_id: i64,
    cloud_account_email: &str,
    cloud_user_id: &str,
    cloud_last_synced_at: &str,
    cloud_sync_status: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE clients
         SET cloud_account_email=?1,
             cloud_user_id=?2,
             cloud_last_synced_at=?3,
             cloud_sync_status=?4
         WHERE id=?5",
        params![
            cloud_account_email,
            cloud_user_id,
            cloud_last_synced_at,
            cloud_sync_status,
            client_id
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[allow(dead_code)]
fn build_client_snapshot(conn: &Connection, client_id: i64) -> Result<Value, String> {
    let settings = load_app_settings_from_conn(conn);
    let synced_at = current_timestamp_iso(conn);

    let client = conn
        .query_row(
            "SELECT id, name, phone, email, address, company, notes, cloud_account_email, cloud_user_id, cloud_last_synced_at, cloud_sync_status
             FROM clients WHERE id=?1",
            params![client_id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "phone": r.get::<_, String>(2).unwrap_or_default(),
                    "email": r.get::<_, String>(3).unwrap_or_default(),
                    "address": r.get::<_, String>(4).unwrap_or_default(),
                    "company": r.get::<_, String>(5).unwrap_or_default(),
                    "notes": r.get::<_, String>(6).unwrap_or_default(),
                    "cloud_account_email": r.get::<_, String>(7).unwrap_or_default(),
                    "cloud_user_id": r.get::<_, String>(8).unwrap_or_default(),
                    "cloud_last_synced_at": r.get::<_, String>(9).unwrap_or_default(),
                    "cloud_sync_status": r.get::<_, String>(10).unwrap_or_default(),
                }))
            },
        )
        .map_err(|e| e.to_string())?;

    let mut vehicles_stmt = conn
        .prepare(
            "SELECT id, client_id, registration, vin, make, model, year, engine, fuel_type, colour, mileage, mot_due, service_due, notes
             FROM vehicles WHERE client_id=?1 ORDER BY registration",
        )
        .map_err(|e| e.to_string())?;
    let vehicles: Vec<Value> = vehicles_stmt
        .query_map(params![client_id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "client_id": r.get::<_, i64>(1)?,
                "registration": r.get::<_, String>(2).unwrap_or_default(),
                "vin": r.get::<_, String>(3).unwrap_or_default(),
                "make": r.get::<_, String>(4).unwrap_or_default(),
                "model": r.get::<_, String>(5).unwrap_or_default(),
                "year": r.get::<_, i32>(6).unwrap_or(0),
                "engine": r.get::<_, String>(7).unwrap_or_default(),
                "fuel_type": r.get::<_, String>(8).unwrap_or_default(),
                "colour": r.get::<_, String>(9).unwrap_or_default(),
                "mileage": r.get::<_, i64>(10).unwrap_or(0),
                "mot_due": r.get::<_, String>(11).unwrap_or_default(),
                "service_due": r.get::<_, String>(12).unwrap_or_default(),
                "notes": r.get::<_, String>(13).unwrap_or_default(),
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let mut bookings_stmt = conn
        .prepare(
            "SELECT b.id, b.client_id, b.vehicle_id, b.date, b.time, b.reason, b.status, b.notes,
                    COALESCE(v.registration, ''), COALESCE(v.make, ''), COALESCE(v.model, '')
             FROM bookings b
             LEFT JOIN vehicles v ON v.id=b.vehicle_id
             WHERE b.client_id=?1
             ORDER BY b.date, b.time",
        )
        .map_err(|e| e.to_string())?;
    let bookings: Vec<Value> = bookings_stmt
        .query_map(params![client_id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "client_id": r.get::<_, i64>(1)?,
                "vehicle_id": r.get::<_, i64>(2)?,
                "date": r.get::<_, String>(3).unwrap_or_default(),
                "time": r.get::<_, String>(4).unwrap_or_default(),
                "reason": r.get::<_, String>(5).unwrap_or_default(),
                "status": r.get::<_, String>(6).unwrap_or_default(),
                "notes": r.get::<_, String>(7).unwrap_or_default(),
                "registration": r.get::<_, String>(8).unwrap_or_default(),
                "make": r.get::<_, String>(9).unwrap_or_default(),
                "model": r.get::<_, String>(10).unwrap_or_default(),
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let mut jobs_stmt = conn
        .prepare(
            "SELECT jc.id, jc.client_id, jc.vehicle_id, COALESCE(jc.booking_id, 0), jc.status, jc.complaint, jc.findings,
                    jc.work_performed, jc.mechanic, jc.mileage_in, jc.mileage_out, jc.est_completion,
                    jc.internal_notes, jc.customer_notes, jc.date_opened,
                    COALESCE(v.registration, ''), COALESCE(v.make, ''), COALESCE(v.model, '')
             FROM job_cards jc
             LEFT JOIN vehicles v ON v.id=jc.vehicle_id
             WHERE jc.client_id=?1
             ORDER BY jc.date_opened DESC, jc.id DESC",
        )
        .map_err(|e| e.to_string())?;
    let job_rows: Vec<Value> = jobs_stmt
        .query_map(params![client_id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "client_id": r.get::<_, i64>(1)?,
                "vehicle_id": r.get::<_, i64>(2)?,
                "booking_id": r.get::<_, i64>(3).unwrap_or(0),
                "status": r.get::<_, String>(4).unwrap_or_default(),
                "complaint": r.get::<_, String>(5).unwrap_or_default(),
                "findings": r.get::<_, String>(6).unwrap_or_default(),
                "work_performed": r.get::<_, String>(7).unwrap_or_default(),
                "mechanic": r.get::<_, String>(8).unwrap_or_default(),
                "mileage_in": r.get::<_, i64>(9).unwrap_or(0),
                "mileage_out": r.get::<_, i64>(10).unwrap_or(0),
                "est_completion": r.get::<_, String>(11).unwrap_or_default(),
                "internal_notes": r.get::<_, String>(12).unwrap_or_default(),
                "customer_notes": r.get::<_, String>(13).unwrap_or_default(),
                "date_opened": r.get::<_, String>(14).unwrap_or_default(),
                "registration": r.get::<_, String>(15).unwrap_or_default(),
                "make": r.get::<_, String>(16).unwrap_or_default(),
                "model": r.get::<_, String>(17).unwrap_or_default(),
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let invoice_vat_rate = invoice_vat_rate_from_settings(&load_app_settings_from_conn(&conn));

    let jobs = job_rows
        .into_iter()
        .map(|job| -> Result<Value, String> {
            let job_id = job
                .get("id")
                .and_then(Value::as_i64)
                .ok_or_else(|| "Job id missing".to_string())?;

            let mut lines_stmt = conn
                .prepare(
                    "SELECT jl.id, jl.job_id, jl.line_type, jl.description, jl.qty, jl.unit_price,
                            jl.line_status, jl.inventory_item_id, jl.inventory_stock_qty_applied
                     FROM job_lines jl WHERE jl.job_id=?1 ORDER BY jl.id",
                )
                .map_err(|e| e.to_string())?;
            let lines: Vec<Value> = lines_stmt
                .query_map(params![job_id], |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "job_id": r.get::<_, i64>(1)?,
                        "line_type": r.get::<_, String>(2).unwrap_or_default(),
                        "description": r.get::<_, String>(3).unwrap_or_default(),
                        "qty": r.get::<_, f64>(4).unwrap_or(0.0),
                        "unit_price": r.get::<_, f64>(5).unwrap_or(0.0),
                        "line_status": normalize_job_line_status(&r.get::<_, String>(6).unwrap_or_else(|_| default_job_line_status())),
                        "inventory_item_id": r.get::<_, Option<i64>>(7).unwrap_or(None),
                        "inventory_stock_qty_applied": r.get::<_, f64>(8).unwrap_or(0.0),
                    }))
                })
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .collect();

            let subtotal = lines
                .iter()
                .map(|line| {
                    line.get("qty").and_then(Value::as_f64).unwrap_or(0.0)
                        * line.get("unit_price").and_then(Value::as_f64).unwrap_or(0.0)
                })
                .sum::<f64>();

            let invoice = conn
                .query_row(
                    "SELECT id, job_id, invoice_number, date_issued, due_date, status, payment_method, paid_amount, notes, vat_rate
                     FROM invoices WHERE job_id=?1",
                    params![job_id],
                    |r| {
                        let vat_rate = invoice_vat_rate;
                        let vat = subtotal * vat_rate / 100.0;
                        let total = subtotal + vat;
                        Ok(json!({
                            "id": r.get::<_, i64>(0)?,
                            "job_id": r.get::<_, i64>(1)?,
                            "invoice_number": r.get::<_, String>(2).unwrap_or_default(),
                            "date_issued": r.get::<_, String>(3).unwrap_or_default(),
                            "due_date": r.get::<_, String>(4).unwrap_or_default(),
                            "status": r.get::<_, String>(5).unwrap_or_default(),
                            "payment_method": r.get::<_, String>(6).unwrap_or_default(),
                            "paid_amount": round_money(r.get::<_, f64>(7).unwrap_or(0.0)),
                            "notes": r.get::<_, String>(8).unwrap_or_default(),
                            "vat_rate": vat_rate,
                            "subtotal": (subtotal * 100.0).round() / 100.0,
                            "vat": (vat * 100.0).round() / 100.0,
                            "total": (total * 100.0).round() / 100.0,
                        }))
                    },
                )
                .optional()
                .map_err(|e| e.to_string())?
                .unwrap_or(Value::Null);

            let mut job_value = job;
            job_value["lines"] = Value::Array(lines);
            job_value["invoice"] = invoice;
            Ok(job_value)
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(json!({
        "garage": {
            "name": settings.garage_name,
            "garage_name": settings.garage_name,
            "garage_address": settings.garage_address,
            "garage_phone": settings.garage_phone,
            "garage_email": settings.garage_email,
            "garage_website": settings.garage_website,
            "vat_number": settings.vat_number,
            "company_number": settings.company_number,
            "bank_details": settings.bank_details,
            "payment_terms": settings.payment_terms,
            "language": settings.language,
            "distance_unit": settings.distance_unit,
            "currency": settings.currency,
            "vat_enabled": settings.vat_enabled,
            "default_vat_rate": settings.default_vat_rate,
            "booking_slot_interval": settings.booking_slot_interval,
            "allow_past_booking_times": settings.allow_past_booking_times,
            "inventory_enabled": settings.inventory_enabled,
        },
        "synced_at": synced_at,
        "client": client,
        "vehicles": vehicles,
        "bookings": bookings,
        "jobs": jobs,
    }))
}

fn build_account_snapshot(conn: &Connection) -> Result<Value, String> {
    let settings = load_app_settings_from_conn(conn);
    let synced_at = current_timestamp_iso(conn);

    let mut clients_stmt = conn
        .prepare("SELECT id, name, phone, email, address, company, notes FROM clients ORDER BY id")
        .map_err(|e| e.to_string())?;
    let clients: Vec<Value> = clients_stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "name": r.get::<_, String>(1)?,
                "phone": r.get::<_, String>(2).unwrap_or_default(),
                "email": r.get::<_, String>(3).unwrap_or_default(),
                "address": r.get::<_, String>(4).unwrap_or_default(),
                "company": r.get::<_, String>(5).unwrap_or_default(),
                "notes": r.get::<_, String>(6).unwrap_or_default(),
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let mut vehicles_stmt = conn
        .prepare(
            "SELECT id, client_id, registration, vin, make, model, year, engine, fuel_type, colour, mileage, mot_due, service_due, notes
             FROM vehicles ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let vehicles: Vec<Value> = vehicles_stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "client_id": r.get::<_, i64>(1)?,
                "registration": r.get::<_, String>(2).unwrap_or_default(),
                "vin": r.get::<_, String>(3).unwrap_or_default(),
                "make": r.get::<_, String>(4).unwrap_or_default(),
                "model": r.get::<_, String>(5).unwrap_or_default(),
                "year": r.get::<_, i32>(6).unwrap_or(0),
                "engine": r.get::<_, String>(7).unwrap_or_default(),
                "fuel_type": r.get::<_, String>(8).unwrap_or_default(),
                "colour": r.get::<_, String>(9).unwrap_or_default(),
                "mileage": r.get::<_, i64>(10).unwrap_or(0),
                "mot_due": r.get::<_, String>(11).unwrap_or_default(),
                "service_due": r.get::<_, String>(12).unwrap_or_default(),
                "notes": r.get::<_, String>(13).unwrap_or_default(),
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let mut jobs_stmt = conn
        .prepare(
            "SELECT id, client_id, vehicle_id, COALESCE(booking_id, 0), status, complaint, findings, work_performed, mechanic, mileage_in, mileage_out, est_completion, internal_notes, customer_notes, date_opened
             FROM job_cards ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let job_cards: Vec<Value> = jobs_stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "client_id": r.get::<_, i64>(1)?,
                "vehicle_id": r.get::<_, i64>(2)?,
                "booking_id": r.get::<_, i64>(3).unwrap_or(0),
                "status": r.get::<_, String>(4).unwrap_or_default(),
                "complaint": r.get::<_, String>(5).unwrap_or_default(),
                "findings": r.get::<_, String>(6).unwrap_or_default(),
                "work_performed": r.get::<_, String>(7).unwrap_or_default(),
                "mechanic": r.get::<_, String>(8).unwrap_or_default(),
                "mileage_in": r.get::<_, i64>(9).unwrap_or(0),
                "mileage_out": r.get::<_, i64>(10).unwrap_or(0),
                "est_completion": r.get::<_, String>(11).unwrap_or_default(),
                "internal_notes": r.get::<_, String>(12).unwrap_or_default(),
                "customer_notes": r.get::<_, String>(13).unwrap_or_default(),
                "date_opened": r.get::<_, String>(14).unwrap_or_default(),
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let mut lines_stmt = conn
        .prepare("SELECT id, job_id, line_type, description, qty, unit_price, line_status, inventory_item_id, inventory_stock_qty_applied FROM job_lines ORDER BY id")
        .map_err(|e| e.to_string())?;
    let job_lines: Vec<Value> = lines_stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "job_id": r.get::<_, i64>(1)?,
                "line_type": r.get::<_, String>(2).unwrap_or_default(),
                "description": r.get::<_, String>(3).unwrap_or_default(),
                "qty": r.get::<_, f64>(4).unwrap_or(0.0),
                "unit_price": r.get::<_, f64>(5).unwrap_or(0.0),
                "line_status": normalize_job_line_status(&r.get::<_, String>(6).unwrap_or_else(|_| default_job_line_status())),
                "inventory_item_id": r.get::<_, Option<i64>>(7).unwrap_or(None),
                "inventory_stock_qty_applied": r.get::<_, f64>(8).unwrap_or(0.0),
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let mut invoices_stmt = conn
        .prepare(
            "SELECT id, job_id, invoice_number, date_issued, due_date, status, payment_method, paid_amount, notes, vat_rate
             FROM invoices ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let invoices: Vec<Value> = invoices_stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "job_id": r.get::<_, i64>(1)?,
                "invoice_number": r.get::<_, String>(2).unwrap_or_default(),
                "date_issued": r.get::<_, String>(3).unwrap_or_default(),
                "due_date": r.get::<_, String>(4).unwrap_or_default(),
                "status": r.get::<_, String>(5).unwrap_or_default(),
                "payment_method": r.get::<_, String>(6).unwrap_or_default(),
                "paid_amount": round_money(r.get::<_, f64>(7).unwrap_or(0.0)),
                "notes": r.get::<_, String>(8).unwrap_or_default(),
                "vat_rate": r.get::<_, f64>(9).unwrap_or(20.0),
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let mut bookings_stmt = conn
        .prepare("SELECT id, client_id, vehicle_id, date, time, reason, status, notes FROM bookings ORDER BY id")
        .map_err(|e| e.to_string())?;
    let bookings: Vec<Value> = bookings_stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "client_id": r.get::<_, i64>(1)?,
                "vehicle_id": r.get::<_, i64>(2)?,
                "date": r.get::<_, String>(3).unwrap_or_default(),
                "time": r.get::<_, String>(4).unwrap_or_default(),
                "reason": r.get::<_, String>(5).unwrap_or_default(),
                "status": r.get::<_, String>(6).unwrap_or_default(),
                "notes": r.get::<_, String>(7).unwrap_or_default(),
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let mut inventory_items_stmt = conn
        .prepare(
            "SELECT id, part_name, sku, category, supplier, quantity, minimum_stock_level, purchase_cost, sell_price, margin_percent, price_mode, notes
             FROM inventory_items ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let inventory_items: Vec<Value> = inventory_items_stmt
        .query_map([], |r| {
            let purchase_cost = r.get::<_, f64>(7).unwrap_or(0.0);
            let (sell_price, margin_percent, price_mode) = resolve_inventory_pricing(
                purchase_cost,
                r.get::<_, f64>(8).unwrap_or(0.0),
                r.get::<_, f64>(9).unwrap_or(0.0),
                &r.get::<_, String>(10)
                    .unwrap_or_else(|_| default_inventory_price_mode()),
            );
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "part_name": r.get::<_, String>(1)?,
                "sku": r.get::<_, String>(2).unwrap_or_default(),
                "category": r.get::<_, String>(3).unwrap_or_default(),
                "supplier": r.get::<_, String>(4).unwrap_or_default(),
                "quantity": r.get::<_, f64>(5).unwrap_or(0.0),
                "minimum_stock_level": r.get::<_, f64>(6).unwrap_or(0.0),
                "purchase_cost": purchase_cost,
                "sell_price": sell_price,
                "margin_percent": margin_percent,
                "price_mode": price_mode,
                "notes": r.get::<_, String>(11).unwrap_or_default(),
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let mut inventory_movements_stmt = conn
        .prepare(
            "SELECT id, inventory_item_id, movement_type, quantity, movement_date, notes
             FROM inventory_movements ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let inventory_movements: Vec<Value> = inventory_movements_stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "inventory_item_id": r.get::<_, i64>(1)?,
                "movement_type": normalize_inventory_movement_type(&r.get::<_, String>(2).unwrap_or_default()),
                "quantity": r.get::<_, f64>(3).unwrap_or(0.0),
                "movement_date": r.get::<_, String>(4).unwrap_or_default(),
                "notes": r.get::<_, String>(5).unwrap_or_default(),
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let message_settings = load_message_settings_from_conn(conn);
    let message_settings_snapshot = json!({
        "sms_enabled": message_settings.sms_enabled,
        "auto_booking_sms": message_settings.auto_booking_sms,
        "auto_job_completed_sms": message_settings.auto_job_completed_sms,
        "manual_sms_enabled": message_settings.manual_sms_enabled,
        "booking_reminders_enabled": message_settings.booking_reminders_enabled,
        "ready_messages_enabled": message_settings.ready_messages_enabled,
        "mot_reminders_enabled": message_settings.mot_reminders_enabled,
        "service_reminders_enabled": message_settings.service_reminders_enabled,
        "reminder_30_days": message_settings.reminder_30_days,
        "reminder_14_days": message_settings.reminder_14_days,
        "reminder_7_days": message_settings.reminder_7_days,
        "reminder_due_today": message_settings.reminder_due_today,
        "automatic_reminder_time": message_settings.automatic_reminder_time,
        "booking_days_before": message_settings.booking_days_before,
        "mot_days_before": message_settings.mot_days_before,
        "service_days_before": message_settings.service_days_before,
        "garage_phone": message_settings.garage_phone,
        "booking_template": message_settings.booking_template,
        "ready_template": message_settings.ready_template,
        "mot_template": message_settings.mot_template,
        "service_template": message_settings.service_template,
        "completed_template": message_settings.completed_template,
    });

    let mut message_log_stmt = conn
        .prepare(
            "SELECT id, channel, category, customer_id, vehicle_id, booking_id, job_card_id, reminder_type, reminder_stage, recipient_name, recipient_phone, body, status, related_type, related_id, error, provider_message_id, scheduled_for, sent_at, created_at
             FROM message_log ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let message_log: Vec<Value> = message_log_stmt
        .query_map([], map_message_log_row)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let mut reminder_history_stmt = conn
        .prepare(
            "SELECT id, vehicle_id, customer_id, reminder_type, due_date, reminder_stage, sent_at, status, message_log_id, created_at
             FROM sms_reminder_history ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let sms_reminder_history: Vec<Value> = reminder_history_stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "vehicle_id": r.get::<_, Option<i64>>(1).unwrap_or(None),
                "customer_id": r.get::<_, Option<i64>>(2).unwrap_or(None),
                "reminder_type": r.get::<_, String>(3).unwrap_or_default(),
                "due_date": r.get::<_, String>(4).unwrap_or_default(),
                "reminder_stage": r.get::<_, String>(5).unwrap_or_default(),
                "sent_at": r.get::<_, String>(6).unwrap_or_default(),
                "status": r.get::<_, String>(7).unwrap_or_default(),
                "message_log_id": r.get::<_, Option<i64>>(8).unwrap_or(None),
                "created_at": r.get::<_, String>(9).unwrap_or_default(),
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    Ok(json!({
        "schema_version": 5,
        "synced_at": synced_at,
        "garage": {
            "garage_name": settings.garage_name,
            "garage_address": settings.garage_address,
            "garage_phone": settings.garage_phone,
            "garage_email": settings.garage_email,
            "garage_website": settings.garage_website,
            "vat_number": settings.vat_number,
            "company_number": settings.company_number,
            "bank_details": settings.bank_details,
            "payment_terms": settings.payment_terms,
            "language": settings.language,
            "distance_unit": settings.distance_unit,
            "currency": settings.currency,
            "vat_enabled": settings.vat_enabled,
            "default_vat_rate": settings.default_vat_rate,
            "booking_slot_interval": settings.booking_slot_interval,
            "allow_past_booking_times": settings.allow_past_booking_times,
            "inventory_enabled": settings.inventory_enabled,
        },
        "clients": clients,
        "vehicles": vehicles,
        "job_cards": job_cards,
        "job_lines": job_lines,
        "invoices": invoices,
        "bookings": bookings,
        "inventory_items": inventory_items,
        "inventory_movements": inventory_movements,
        "message_settings": message_settings_snapshot,
        "message_log": message_log,
        "sms_reminder_history": sms_reminder_history,
    }))
}

fn apply_account_snapshot(conn: &Connection, snapshot: &Value) -> Result<(), String> {
    let garage = snapshot.get("garage").cloned().unwrap_or_else(|| json!({}));
    let clients = snapshot
        .get("clients")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let vehicles = snapshot
        .get("vehicles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let job_cards = snapshot
        .get("job_cards")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let job_lines = snapshot
        .get("job_lines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let invoices = snapshot
        .get("invoices")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let bookings = snapshot
        .get("bookings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let inventory_items = snapshot
        .get("inventory_items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let inventory_movements = snapshot
        .get("inventory_movements")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let message_settings_snapshot = snapshot
        .get("message_settings")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let message_log = snapshot
        .get("message_log")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let sms_reminder_history = snapshot
        .get("sms_reminder_history")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    conn.execute("DELETE FROM sms_reminder_history", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM message_log", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM inventory_movements", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM inventory_items", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM bookings", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM invoices", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM job_lines", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM job_cards", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM vehicles", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM clients", [])
        .map_err(|e| e.to_string())?;

    for client in clients {
        conn.execute(
            "INSERT INTO clients (id, name, phone, email, address, company, notes, cloud_account_email, cloud_user_id, cloud_last_synced_at, cloud_sync_status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', '', '', 'Local only')",
            params![
                client.get("id").and_then(Value::as_i64).unwrap_or(0),
                client.get("name").and_then(Value::as_str).unwrap_or(""),
                client.get("phone").and_then(Value::as_str).unwrap_or(""),
                client.get("email").and_then(Value::as_str).unwrap_or(""),
                client.get("address").and_then(Value::as_str).unwrap_or(""),
                client.get("company").and_then(Value::as_str).unwrap_or(""),
                client.get("notes").and_then(Value::as_str).unwrap_or("")
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for vehicle in vehicles {
        conn.execute(
            "INSERT INTO vehicles (id, client_id, registration, vin, make, model, year, engine, fuel_type, colour, mileage, mot_due, service_due, notes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                vehicle.get("id").and_then(Value::as_i64).unwrap_or(0),
                vehicle.get("client_id").and_then(Value::as_i64).unwrap_or(0),
                vehicle.get("registration").and_then(Value::as_str).unwrap_or(""),
                vehicle.get("vin").and_then(Value::as_str).unwrap_or(""),
                vehicle.get("make").and_then(Value::as_str).unwrap_or(""),
                vehicle.get("model").and_then(Value::as_str).unwrap_or(""),
                vehicle.get("year").and_then(Value::as_i64).unwrap_or(0),
                vehicle.get("engine").and_then(Value::as_str).unwrap_or(""),
                vehicle.get("fuel_type").and_then(Value::as_str).unwrap_or(""),
                vehicle.get("colour").and_then(Value::as_str).unwrap_or(""),
                vehicle.get("mileage").and_then(Value::as_i64).unwrap_or(0),
                vehicle.get("mot_due").and_then(Value::as_str).unwrap_or(""),
                vehicle.get("service_due").and_then(Value::as_str).unwrap_or(""),
                vehicle.get("notes").and_then(Value::as_str).unwrap_or("")
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for job in job_cards {
        conn.execute(
            "INSERT INTO job_cards (id, client_id, vehicle_id, booking_id, status, complaint, findings, work_performed, mechanic, mileage_in, mileage_out, est_completion, internal_notes, customer_notes, date_opened)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                job.get("id").and_then(Value::as_i64).unwrap_or(0),
                job.get("client_id").and_then(Value::as_i64).unwrap_or(0),
                job.get("vehicle_id").and_then(Value::as_i64).unwrap_or(0),
                job.get("booking_id").and_then(Value::as_i64).filter(|id| *id > 0),
                job.get("status").and_then(Value::as_str).unwrap_or(""),
                job.get("complaint").and_then(Value::as_str).unwrap_or(""),
                job.get("findings").and_then(Value::as_str).unwrap_or(""),
                job.get("work_performed").and_then(Value::as_str).unwrap_or(""),
                job.get("mechanic").and_then(Value::as_str).unwrap_or(""),
                job.get("mileage_in").and_then(Value::as_i64).unwrap_or(0),
                job.get("mileage_out").and_then(Value::as_i64).unwrap_or(0),
                job.get("est_completion").and_then(Value::as_str).unwrap_or(""),
                job.get("internal_notes").and_then(Value::as_str).unwrap_or(""),
                job.get("customer_notes").and_then(Value::as_str).unwrap_or(""),
                job.get("date_opened").and_then(Value::as_str).unwrap_or("")
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for line in job_lines {
        let line_status = normalize_job_line_status(
            line.get("line_status")
                .and_then(Value::as_str)
                .unwrap_or("confirmed"),
        );
        conn.execute(
            "INSERT INTO job_lines (id, job_id, line_type, description, qty, unit_price, line_status, inventory_item_id, inventory_stock_qty_applied)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                line.get("id").and_then(Value::as_i64).unwrap_or(0),
                line.get("job_id").and_then(Value::as_i64).unwrap_or(0),
                line.get("line_type").and_then(Value::as_str).unwrap_or(""),
                line.get("description").and_then(Value::as_str).unwrap_or(""),
                line.get("qty").and_then(Value::as_f64).unwrap_or(0.0),
                line.get("unit_price").and_then(Value::as_f64).unwrap_or(0.0),
                line_status,
                line.get("inventory_item_id")
                    .or_else(|| line.get("inventoryItemId"))
                    .and_then(Value::as_i64)
                    .filter(|id| *id > 0),
                line.get("inventory_stock_qty_applied")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for invoice in invoices {
        conn.execute(
            "INSERT INTO invoices (id, job_id, invoice_number, date_issued, due_date, status, payment_method, paid_amount, notes, vat_rate)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                invoice.get("id").and_then(Value::as_i64).unwrap_or(0),
                invoice.get("job_id").and_then(Value::as_i64).unwrap_or(0),
                invoice.get("invoice_number").and_then(Value::as_str).unwrap_or(""),
                invoice.get("date_issued").and_then(Value::as_str).unwrap_or(""),
                invoice.get("due_date").and_then(Value::as_str).unwrap_or(""),
                invoice.get("status").and_then(Value::as_str).unwrap_or(""),
                invoice.get("payment_method").and_then(Value::as_str).unwrap_or(""),
                round_money(invoice.get("paid_amount").and_then(Value::as_f64).unwrap_or(0.0)),
                invoice.get("notes").and_then(Value::as_str).unwrap_or(""),
                invoice.get("vat_rate").and_then(Value::as_f64).unwrap_or(20.0)
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for booking in bookings {
        conn.execute(
            "INSERT INTO bookings (id, client_id, vehicle_id, date, time, reason, status, notes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                booking.get("id").and_then(Value::as_i64).unwrap_or(0),
                booking
                    .get("client_id")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                booking
                    .get("vehicle_id")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                booking.get("date").and_then(Value::as_str).unwrap_or(""),
                booking.get("time").and_then(Value::as_str).unwrap_or(""),
                booking.get("reason").and_then(Value::as_str).unwrap_or(""),
                booking.get("status").and_then(Value::as_str).unwrap_or(""),
                booking.get("notes").and_then(Value::as_str).unwrap_or("")
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for item in inventory_items {
        let purchase_cost = sanitize_stock_number(
            item.get("purchase_cost")
                .or_else(|| item.get("purchaseCost"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
        );
        let (sell_price, margin_percent, price_mode) = resolve_inventory_pricing(
            purchase_cost,
            item.get("sell_price")
                .or_else(|| item.get("sellPrice"))
                .or_else(|| item.get("retail_price"))
                .or_else(|| item.get("retailPrice"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            item.get("margin_percent")
                .or_else(|| item.get("marginPercent"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            item.get("price_mode")
                .or_else(|| item.get("priceMode"))
                .and_then(Value::as_str)
                .unwrap_or("auto"),
        );
        conn.execute(
            "INSERT INTO inventory_items (id, part_name, sku, category, supplier, quantity, minimum_stock_level, purchase_cost, sell_price, margin_percent, price_mode, notes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                item.get("id").and_then(Value::as_i64).unwrap_or(0),
                item.get("part_name")
                    .or_else(|| item.get("partName"))
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                item.get("sku").and_then(Value::as_str).unwrap_or(""),
                item.get("category").and_then(Value::as_str).unwrap_or(""),
                item.get("supplier").and_then(Value::as_str).unwrap_or(""),
                sanitize_stock_number(item.get("quantity").and_then(Value::as_f64).unwrap_or(0.0)),
                sanitize_stock_number(
                    item.get("minimum_stock_level")
                        .or_else(|| item.get("reorderLevel"))
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0)
                ),
                purchase_cost,
                sell_price,
                margin_percent,
                price_mode,
                item.get("notes").and_then(Value::as_str).unwrap_or("")
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for movement in inventory_movements {
        conn.execute(
            "INSERT INTO inventory_movements (id, inventory_item_id, movement_type, quantity, movement_date, notes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                movement.get("id").and_then(Value::as_i64).unwrap_or(0),
                movement
                    .get("inventory_item_id")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                normalize_inventory_movement_type(
                    movement
                        .get("movement_type")
                        .or_else(|| movement.get("movementType"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                ),
                sanitize_stock_delta(movement.get("quantity").and_then(Value::as_f64).unwrap_or(0.0)),
                movement
                    .get("movement_date")
                    .or_else(|| movement.get("movementDate"))
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                movement.get("notes").and_then(Value::as_str).unwrap_or("")
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for message in message_log {
        conn.execute(
            "INSERT INTO message_log (id, channel, category, customer_id, vehicle_id, booking_id, job_card_id, reminder_type, reminder_stage, recipient_name, recipient_phone, body, status, related_type, related_id, error, provider_message_id, scheduled_for, sent_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            params![
                message.get("id").and_then(Value::as_i64).unwrap_or(0),
                message.get("channel").and_then(Value::as_str).unwrap_or("sms"),
                sanitize_message_category(message.get("category").and_then(Value::as_str).unwrap_or("custom")),
                message.get("customer_id").or_else(|| message.get("customerId")).and_then(Value::as_i64),
                message.get("vehicle_id").or_else(|| message.get("vehicleId")).and_then(Value::as_i64),
                message.get("booking_id").or_else(|| message.get("bookingId")).and_then(Value::as_i64),
                message.get("job_card_id").or_else(|| message.get("jobCardId")).and_then(Value::as_i64),
                message.get("reminder_type").or_else(|| message.get("reminderType")).and_then(Value::as_str).unwrap_or(""),
                message.get("reminder_stage").or_else(|| message.get("reminderStage")).and_then(Value::as_str).unwrap_or(""),
                message.get("recipient_name").and_then(Value::as_str).unwrap_or(""),
                sanitize_phone_for_sms(message.get("recipient_phone").and_then(Value::as_str).unwrap_or("")),
                message.get("body").and_then(Value::as_str).unwrap_or(""),
                message.get("status").and_then(Value::as_str).unwrap_or("Draft"),
                message.get("related_type").and_then(Value::as_str).unwrap_or(""),
                message.get("related_id").and_then(Value::as_i64),
                message.get("error").and_then(Value::as_str).unwrap_or(""),
                message.get("provider_message_id").and_then(Value::as_str).unwrap_or(""),
                message.get("scheduled_for").and_then(Value::as_str).unwrap_or(""),
                message.get("sent_at").and_then(Value::as_str).unwrap_or(""),
                message.get("created_at").and_then(Value::as_str).unwrap_or("")
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for reminder in sms_reminder_history {
        conn.execute(
            "INSERT OR IGNORE INTO sms_reminder_history (id, vehicle_id, customer_id, reminder_type, due_date, reminder_stage, sent_at, status, message_log_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                reminder.get("id").and_then(Value::as_i64).unwrap_or(0),
                reminder.get("vehicle_id").or_else(|| reminder.get("vehicleId")).and_then(Value::as_i64),
                reminder.get("customer_id").or_else(|| reminder.get("customerId")).and_then(Value::as_i64),
                reminder.get("reminder_type").or_else(|| reminder.get("reminderType")).and_then(Value::as_str).unwrap_or(""),
                reminder.get("due_date").or_else(|| reminder.get("dueDate")).and_then(Value::as_str).unwrap_or(""),
                reminder.get("reminder_stage").or_else(|| reminder.get("reminderStage")).and_then(Value::as_str).unwrap_or(""),
                reminder.get("sent_at").or_else(|| reminder.get("sentAt")).and_then(Value::as_str).unwrap_or(""),
                reminder.get("status").and_then(Value::as_str).unwrap_or(""),
                reminder.get("message_log_id").or_else(|| reminder.get("messageLogId")).and_then(Value::as_i64),
                reminder.get("created_at").or_else(|| reminder.get("createdAt")).and_then(Value::as_str).unwrap_or("")
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    let current_message_settings = load_message_settings_from_conn(conn);
    let next_message_settings = MessageSettings {
        sms_enabled: message_settings_snapshot
            .get("sms_enabled")
            .and_then(Value::as_bool)
            .unwrap_or(current_message_settings.sms_enabled),
        auto_booking_sms: message_settings_snapshot
            .get("auto_booking_sms")
            .and_then(Value::as_bool)
            .unwrap_or(current_message_settings.auto_booking_sms),
        auto_job_completed_sms: message_settings_snapshot
            .get("auto_job_completed_sms")
            .and_then(Value::as_bool)
            .unwrap_or(current_message_settings.auto_job_completed_sms),
        manual_sms_enabled: message_settings_snapshot
            .get("manual_sms_enabled")
            .and_then(Value::as_bool)
            .unwrap_or(current_message_settings.manual_sms_enabled),
        booking_reminders_enabled: message_settings_snapshot
            .get("booking_reminders_enabled")
            .and_then(Value::as_bool)
            .unwrap_or(current_message_settings.booking_reminders_enabled),
        ready_messages_enabled: message_settings_snapshot
            .get("ready_messages_enabled")
            .and_then(Value::as_bool)
            .unwrap_or(current_message_settings.ready_messages_enabled),
        mot_reminders_enabled: message_settings_snapshot
            .get("mot_reminders_enabled")
            .and_then(Value::as_bool)
            .unwrap_or(current_message_settings.mot_reminders_enabled),
        service_reminders_enabled: message_settings_snapshot
            .get("service_reminders_enabled")
            .and_then(Value::as_bool)
            .unwrap_or(current_message_settings.service_reminders_enabled),
        reminder_30_days: message_settings_snapshot
            .get("reminder_30_days")
            .and_then(Value::as_bool)
            .unwrap_or(current_message_settings.reminder_30_days),
        reminder_14_days: message_settings_snapshot
            .get("reminder_14_days")
            .and_then(Value::as_bool)
            .unwrap_or(current_message_settings.reminder_14_days),
        reminder_7_days: message_settings_snapshot
            .get("reminder_7_days")
            .and_then(Value::as_bool)
            .unwrap_or(current_message_settings.reminder_7_days),
        reminder_due_today: message_settings_snapshot
            .get("reminder_due_today")
            .and_then(Value::as_bool)
            .unwrap_or(current_message_settings.reminder_due_today),
        automatic_reminder_time: message_settings_snapshot
            .get("automatic_reminder_time")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| current_message_settings.automatic_reminder_time.clone()),
        booking_days_before: message_settings_snapshot
            .get("booking_days_before")
            .and_then(Value::as_i64)
            .unwrap_or(current_message_settings.booking_days_before),
        mot_days_before: message_settings_snapshot
            .get("mot_days_before")
            .and_then(Value::as_i64)
            .unwrap_or(current_message_settings.mot_days_before),
        service_days_before: message_settings_snapshot
            .get("service_days_before")
            .and_then(Value::as_i64)
            .unwrap_or(current_message_settings.service_days_before),
        garage_phone: message_settings_snapshot
            .get("garage_phone")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| current_message_settings.garage_phone.clone()),
        booking_template: message_settings_snapshot
            .get("booking_template")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| current_message_settings.booking_template.clone()),
        ready_template: message_settings_snapshot
            .get("ready_template")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| current_message_settings.ready_template.clone()),
        mot_template: message_settings_snapshot
            .get("mot_template")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| current_message_settings.mot_template.clone()),
        service_template: message_settings_snapshot
            .get("service_template")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| current_message_settings.service_template.clone()),
        completed_template: message_settings_snapshot
            .get("completed_template")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| current_message_settings.completed_template.clone()),
    };
    let next_message_settings = sanitize_message_settings(next_message_settings);
    conn.execute(
        "UPDATE message_settings SET sms_enabled=?1, auto_booking_sms=?2, auto_job_completed_sms=?3, manual_sms_enabled=?4, booking_reminders_enabled=?5, ready_messages_enabled=?6, mot_reminders_enabled=?7, service_reminders_enabled=?8, reminder_30_days=?9, reminder_14_days=?10, reminder_7_days=?11, reminder_due_today=?12, automatic_reminder_time=?13, booking_days_before=?14, mot_days_before=?15, service_days_before=?16, twilio_account_sid='', twilio_auth_token='', twilio_from_number='', garage_phone=?17, booking_template=?18, ready_template=?19, mot_template=?20, service_template=?21, completed_template=?22 WHERE id=1",
        params![
            next_message_settings.sms_enabled,
            next_message_settings.auto_booking_sms,
            next_message_settings.auto_job_completed_sms,
            next_message_settings.manual_sms_enabled,
            next_message_settings.booking_reminders_enabled,
            next_message_settings.ready_messages_enabled,
            next_message_settings.mot_reminders_enabled,
            next_message_settings.service_reminders_enabled,
            next_message_settings.reminder_30_days,
            next_message_settings.reminder_14_days,
            next_message_settings.reminder_7_days,
            next_message_settings.reminder_due_today,
            &next_message_settings.automatic_reminder_time,
            next_message_settings.booking_days_before,
            next_message_settings.mot_days_before,
            next_message_settings.service_days_before,
            &next_message_settings.garage_phone,
            &next_message_settings.booking_template,
            &next_message_settings.ready_template,
            &next_message_settings.mot_template,
            &next_message_settings.service_template,
            &next_message_settings.completed_template
        ],
    )
    .map_err(|e| e.to_string())?;

    let current_settings = load_app_settings_from_conn(conn);
    let next_settings = AppSettings {
        garage_name: garage
            .get("garage_name")
            .or_else(|| garage.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("Garage CRM")
            .to_string(),
        garage_address: garage
            .get("garage_address")
            .and_then(Value::as_str)
            .unwrap_or(&current_settings.garage_address)
            .to_string(),
        garage_phone: garage
            .get("garage_phone")
            .and_then(Value::as_str)
            .unwrap_or(&current_settings.garage_phone)
            .to_string(),
        garage_email: garage
            .get("garage_email")
            .and_then(Value::as_str)
            .unwrap_or(&current_settings.garage_email)
            .to_string(),
        garage_website: garage
            .get("garage_website")
            .and_then(Value::as_str)
            .unwrap_or(&current_settings.garage_website)
            .to_string(),
        vat_number: garage
            .get("vat_number")
            .and_then(Value::as_str)
            .unwrap_or(&current_settings.vat_number)
            .to_string(),
        company_number: garage
            .get("company_number")
            .and_then(Value::as_str)
            .unwrap_or(&current_settings.company_number)
            .to_string(),
        bank_details: garage
            .get("bank_details")
            .and_then(Value::as_str)
            .unwrap_or(&current_settings.bank_details)
            .to_string(),
        payment_terms: garage
            .get("payment_terms")
            .and_then(Value::as_str)
            .unwrap_or(&current_settings.payment_terms)
            .to_string(),
        language: garage
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or(&current_settings.language)
            .to_string(),
        distance_unit: garage
            .get("distance_unit")
            .and_then(Value::as_str)
            .unwrap_or("mi")
            .to_string(),
        currency: garage
            .get("currency")
            .and_then(Value::as_str)
            .unwrap_or("GBP")
            .to_string(),
        vat_enabled: garage
            .get("vat_enabled")
            .and_then(Value::as_bool)
            .unwrap_or(current_settings.vat_enabled),
        default_vat_rate: garage
            .get("default_vat_rate")
            .and_then(Value::as_f64)
            .unwrap_or(current_settings.default_vat_rate),
        booking_slot_interval: garage
            .get("booking_slot_interval")
            .and_then(Value::as_i64)
            .unwrap_or_else(default_booking_slot_interval),
        allow_past_booking_times: garage
            .get("allow_past_booking_times")
            .and_then(Value::as_bool)
            .unwrap_or(current_settings.allow_past_booking_times),
        inventory_enabled: garage
            .get("inventory_enabled")
            .and_then(Value::as_bool)
            .unwrap_or(current_settings.inventory_enabled),
        supabase_url: current_settings.supabase_url,
        supabase_service_role_key: current_settings.supabase_service_role_key,
    };
    let next_settings = sanitize_app_settings(next_settings);
    conn.execute(
        "UPDATE app_settings SET garage_name=?1, garage_address=?2, garage_phone=?3, garage_email=?4, garage_website=?5, vat_number=?6, company_number=?7, bank_details=?8, payment_terms=?9, language=?10, distance_unit=?11, currency=?12, vat_enabled=?13, default_vat_rate=?14, booking_slot_interval=?15, allow_past_booking_times=?16, inventory_enabled=?17 WHERE id=1",
        params![
            next_settings.garage_name,
            next_settings.garage_address,
            next_settings.garage_phone,
            next_settings.garage_email,
            next_settings.garage_website,
            next_settings.vat_number,
            next_settings.company_number,
            next_settings.bank_details,
            next_settings.payment_terms,
            next_settings.language,
            next_settings.distance_unit,
            next_settings.currency,
            next_settings.vat_enabled,
            next_settings.default_vat_rate,
            next_settings.booking_slot_interval,
            next_settings.allow_past_booking_times,
            next_settings.inventory_enabled
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

// ─── COMMANDS ────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_dashboard(state: State<DbState>) -> serde_json::Value {
    let conn = state.0.lock().unwrap();
    let cars_in_service: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM job_cards WHERE status NOT IN ('Completed','Cancelled')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let open_jobs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM job_cards WHERE status NOT IN ('Completed','Cancelled')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let unpaid_invoices: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM invoices WHERE status='Unpaid'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let revenue_today: f64 = conn.query_row(
        "SELECT COALESCE(SUM(jl.qty * jl.unit_price),0) FROM job_lines jl JOIN job_cards jc ON jl.job_id=jc.id WHERE jc.date_opened=date('now')", [], |r| r.get(0)).unwrap_or(0.0);
    serde_json::json!({
        "cars_in_service": cars_in_service,
        "open_jobs": open_jobs,
        "unpaid_invoices": unpaid_invoices,
        "revenue_today": revenue_today
    })
}

#[tauri::command]
fn get_app_settings(state: State<DbState>) -> AppSettings {
    let conn = state.0.lock().unwrap();
    load_app_settings_from_conn(&conn)
}

#[tauri::command]
fn save_app_settings(settings: AppSettings, state: State<DbState>) -> Result<AppSettings, String> {
    let conn = state.0.lock().unwrap();
    let settings = sanitize_app_settings(settings);
    conn.execute(
        "INSERT INTO app_settings (id, garage_name, garage_address, garage_phone, garage_email, garage_website, vat_number, company_number, bank_details, payment_terms, language, distance_unit, currency, vat_enabled, default_vat_rate, booking_slot_interval, allow_past_booking_times, inventory_enabled, supabase_url, supabase_service_role_key)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
         ON CONFLICT(id) DO UPDATE SET
            garage_name=excluded.garage_name,
            garage_address=excluded.garage_address,
            garage_phone=excluded.garage_phone,
            garage_email=excluded.garage_email,
            garage_website=excluded.garage_website,
            vat_number=excluded.vat_number,
            company_number=excluded.company_number,
            bank_details=excluded.bank_details,
            payment_terms=excluded.payment_terms,
            language=excluded.language,
            distance_unit=excluded.distance_unit,
            currency=excluded.currency,
            vat_enabled=excluded.vat_enabled,
            default_vat_rate=excluded.default_vat_rate,
            booking_slot_interval=excluded.booking_slot_interval,
            allow_past_booking_times=excluded.allow_past_booking_times,
            inventory_enabled=excluded.inventory_enabled,
            supabase_url=excluded.supabase_url,
            supabase_service_role_key=excluded.supabase_service_role_key",
        params![
            &settings.garage_name,
            &settings.garage_address,
            &settings.garage_phone,
            &settings.garage_email,
            &settings.garage_website,
            &settings.vat_number,
            &settings.company_number,
            &settings.bank_details,
            &settings.payment_terms,
            &settings.language,
            &settings.distance_unit,
            &settings.currency,
            &settings.vat_enabled,
            &settings.default_vat_rate,
            &settings.booking_slot_interval,
            &settings.allow_past_booking_times,
            &settings.inventory_enabled,
            &settings.supabase_url,
            &settings.supabase_service_role_key
        ],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE invoices SET vat_rate=?1",
        params![invoice_vat_rate_from_settings(&settings)],
    )
    .map_err(|e| e.to_string())?;
    Ok(settings)
}

#[tauri::command]
fn get_message_settings(state: State<DbState>) -> MessageSettings {
    let conn = state.0.lock().unwrap();
    load_message_settings_from_conn(&conn)
}

#[tauri::command]
fn save_message_settings(
    settings: MessageSettings,
    state: State<DbState>,
) -> Result<MessageSettings, String> {
    let conn = state.0.lock().unwrap();
    let settings = sanitize_message_settings(settings);
    conn.execute(
        "INSERT INTO message_settings (id, sms_enabled, auto_booking_sms, auto_job_completed_sms, manual_sms_enabled, booking_reminders_enabled, ready_messages_enabled, mot_reminders_enabled, service_reminders_enabled, reminder_30_days, reminder_14_days, reminder_7_days, reminder_due_today, automatic_reminder_time, booking_days_before, mot_days_before, service_days_before, twilio_account_sid, twilio_auth_token, twilio_from_number, garage_phone, booking_template, ready_template, mot_template, service_template, completed_template)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, '', '', '', ?17, ?18, ?19, ?20, ?21, ?22)
         ON CONFLICT(id) DO UPDATE SET
            sms_enabled=excluded.sms_enabled,
            auto_booking_sms=excluded.auto_booking_sms,
            auto_job_completed_sms=excluded.auto_job_completed_sms,
            manual_sms_enabled=excluded.manual_sms_enabled,
            booking_reminders_enabled=excluded.booking_reminders_enabled,
            ready_messages_enabled=excluded.ready_messages_enabled,
            mot_reminders_enabled=excluded.mot_reminders_enabled,
            service_reminders_enabled=excluded.service_reminders_enabled,
            reminder_30_days=excluded.reminder_30_days,
            reminder_14_days=excluded.reminder_14_days,
            reminder_7_days=excluded.reminder_7_days,
            reminder_due_today=excluded.reminder_due_today,
            automatic_reminder_time=excluded.automatic_reminder_time,
            booking_days_before=excluded.booking_days_before,
            mot_days_before=excluded.mot_days_before,
            service_days_before=excluded.service_days_before,
            twilio_account_sid='',
            twilio_auth_token='',
            twilio_from_number='',
            garage_phone=excluded.garage_phone,
            booking_template=excluded.booking_template,
            ready_template=excluded.ready_template,
            mot_template=excluded.mot_template,
            service_template=excluded.service_template,
            completed_template=excluded.completed_template",
        params![
            settings.sms_enabled,
            settings.auto_booking_sms,
            settings.auto_job_completed_sms,
            settings.manual_sms_enabled,
            settings.booking_reminders_enabled,
            settings.ready_messages_enabled,
            settings.mot_reminders_enabled,
            settings.service_reminders_enabled,
            settings.reminder_30_days,
            settings.reminder_14_days,
            settings.reminder_7_days,
            settings.reminder_due_today,
            &settings.automatic_reminder_time,
            settings.booking_days_before,
            settings.mot_days_before,
            settings.service_days_before,
            &settings.garage_phone,
            &settings.booking_template,
            &settings.ready_template,
            &settings.mot_template,
            &settings.service_template,
            &settings.completed_template,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(load_message_settings_from_conn(&conn))
}

fn map_message_log_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "channel": r.get::<_, String>(1).unwrap_or_default(),
        "category": r.get::<_, String>(2).unwrap_or_default(),
        "customer_id": r.get::<_, Option<i64>>(3).unwrap_or(None),
        "vehicle_id": r.get::<_, Option<i64>>(4).unwrap_or(None),
        "booking_id": r.get::<_, Option<i64>>(5).unwrap_or(None),
        "job_card_id": r.get::<_, Option<i64>>(6).unwrap_or(None),
        "reminder_type": r.get::<_, String>(7).unwrap_or_default(),
        "reminder_stage": r.get::<_, String>(8).unwrap_or_default(),
        "recipient_name": r.get::<_, String>(9).unwrap_or_default(),
        "recipient_phone": r.get::<_, String>(10).unwrap_or_default(),
        "body": r.get::<_, String>(11).unwrap_or_default(),
        "status": r.get::<_, String>(12).unwrap_or_default(),
        "related_type": r.get::<_, String>(13).unwrap_or_default(),
        "related_id": r.get::<_, Option<i64>>(14).unwrap_or(None),
        "error": r.get::<_, String>(15).unwrap_or_default(),
        "provider_message_id": r.get::<_, String>(16).unwrap_or_default(),
        "scheduled_for": r.get::<_, String>(17).unwrap_or_default(),
        "sent_at": r.get::<_, String>(18).unwrap_or_default(),
        "created_at": r.get::<_, String>(19).unwrap_or_default(),
    }))
}

fn get_message_log_entry(conn: &Connection, id: i64) -> Result<Value, String> {
    conn.query_row(
        "SELECT id, channel, category, customer_id, vehicle_id, booking_id, job_card_id, reminder_type, reminder_stage, recipient_name, recipient_phone, body, status, related_type, related_id, error, provider_message_id, scheduled_for, sent_at, created_at FROM message_log WHERE id=?1",
        params![id],
        map_message_log_row,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_message_log(limit: Option<i64>, state: State<DbState>) -> Vec<Value> {
    let conn = state.0.lock().unwrap();
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let mut stmt = conn
        .prepare(
            "SELECT id, channel, category, customer_id, vehicle_id, booking_id, job_card_id, reminder_type, reminder_stage, recipient_name, recipient_phone, body, status, related_type, related_id, error, provider_message_id, scheduled_for, sent_at, created_at
             FROM message_log ORDER BY id DESC LIMIT ?1",
        )
        .unwrap();
    stmt.query_map(params![limit], map_message_log_row)
        .unwrap()
        .filter_map(Result::ok)
        .collect()
}

fn insert_message_log(
    conn: &Connection,
    message: &SmsMessagePayload,
    status: &str,
    error: &str,
    provider_message_id: &str,
    sent_at: &str,
) -> Result<i64, String> {
    let category = sanitize_message_category(&message.category);
    let phone = sanitize_phone_for_sms(&message.to);
    conn.execute(
        "INSERT INTO message_log (channel, category, customer_id, vehicle_id, booking_id, job_card_id, reminder_type, reminder_stage, recipient_name, recipient_phone, body, status, related_type, related_id, error, provider_message_id, scheduled_for, sent_at)
         VALUES ('sms', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        params![
            category,
            message.customer_id,
            message.vehicle_id,
            message.booking_id,
            message.job_card_id,
            message.reminder_type.trim(),
            message.reminder_stage.trim(),
            message.recipient_name.trim(),
            phone,
            message.body.trim(),
            status,
            message.related_type.trim(),
            message.related_id,
            error,
            provider_message_id,
            message.scheduled_for.trim(),
            sent_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

fn upsert_sms_reminder_history(
    conn: &Connection,
    message: &SmsMessagePayload,
    status: &str,
    sent_at: &str,
    message_log_id: i64,
) -> Result<(), String> {
    let reminder_type = message.reminder_type.trim();
    let reminder_stage = message.reminder_stage.trim();
    if reminder_type.is_empty() || reminder_stage.is_empty() {
        return Ok(());
    }
    let due_date = message.scheduled_for.trim();
    conn.execute(
        "INSERT INTO sms_reminder_history (vehicle_id, customer_id, reminder_type, due_date, reminder_stage, sent_at, status, message_log_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(vehicle_id, customer_id, reminder_type, due_date, reminder_stage) DO UPDATE SET
            sent_at=excluded.sent_at,
            status=excluded.status,
            message_log_id=excluded.message_log_id",
        params![
            message.vehicle_id,
            message.customer_id,
            reminder_type,
            due_date,
            reminder_stage,
            sent_at,
            status,
            message_log_id,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn validate_sms_message(message: &SmsMessagePayload) -> Result<(), String> {
    if sanitize_phone_for_sms(&message.to).is_empty() {
        return Err("SMS recipient phone number is required.".to_string());
    }
    let body = message.body.trim();
    if body.is_empty() {
        return Err("SMS body is required.".to_string());
    }
    if body.chars().count() > 1600 {
        return Err("SMS body is too long. Keep it under 1600 characters.".to_string());
    }
    Ok(())
}

fn normalize_message_send_status(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "queued" => "Queued".to_string(),
        "sent" | "delivered" | "accepted" | "ok" | "success" => "Sent".to_string(),
        _ => "Sent".to_string(),
    }
}

fn send_supabase_sms(
    config: &CloudBuildConfig,
    session: &CloudSession,
    message: &SmsMessagePayload,
) -> Result<(String, String), String> {
    if session.user_id.trim().is_empty() || session.access_token.trim().is_empty() {
        return Err("Sign in before sending SMS.".to_string());
    }
    let endpoint = format!(
        "{}/functions/v1/{}",
        config.supabase_url.trim_end_matches('/'),
        SUPABASE_SMS_FUNCTION
    );
    let payload = json!({
        "category": sanitize_message_category(&message.category),
        "to": sanitize_phone_for_sms(&message.to),
        "body": message.body.trim(),
        "recipientName": message.recipient_name.trim(),
        "relatedType": message.related_type.trim(),
        "relatedId": message.related_id,
        "scheduledFor": message.scheduled_for.trim(),
        "customerId": message.customer_id,
        "vehicleId": message.vehicle_id,
        "bookingId": message.booking_id,
        "jobCardId": message.job_card_id,
        "reminderType": message.reminder_type.trim(),
        "reminderStage": message.reminder_stage.trim(),
    });
    let response = cloud_rest_headers(http_client().post(endpoint), config, &session.access_token)
        .json(&payload)
        .send()
        .map_err(|e| format!("Failed to reach messaging service: {}", e))?;
    let status = response.status();
    let response_json: Value = response.json().unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let message = response_json
            .get("message")
            .or_else(|| response_json.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("Messaging service rejected the request.");
        return Err(format!("Messaging error {}: {}", status.as_u16(), message));
    }
    let provider_id = response_json
        .get("sid")
        .or_else(|| response_json.get("messageSid"))
        .or_else(|| response_json.get("providerMessageId"))
        .or_else(|| response_json.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let provider_status = response_json
        .get("status")
        .and_then(Value::as_str)
        .map(normalize_message_send_status)
        .unwrap_or_else(|| "Sent".to_string());
    Ok((provider_id, provider_status))
}

#[tauri::command]
fn send_sms_message(message: SmsMessagePayload, state: State<DbState>) -> Result<Value, String> {
    let conn = state.0.lock().unwrap();
    let validation = validate_sms_message(&message);
    if let Err(error) = validation {
        let sent_at = current_timestamp_iso(&conn);
        let id = insert_message_log(&conn, &message, "Failed", &error, "", &sent_at)?;
        upsert_sms_reminder_history(&conn, &message, "Failed", &sent_at, id)?;
        return Err(error);
    }
    let app_settings = load_app_settings_from_conn(&conn);
    let cloud_config = ensure_cloud_configured(Some(&app_settings))?;
    let session = load_cloud_session_from_conn(&conn);
    match send_supabase_sms(&cloud_config, &session, &message) {
        Ok((provider_id, provider_status)) => {
            let sent_at = current_timestamp_iso(&conn);
            let id = insert_message_log(
                &conn,
                &message,
                &provider_status,
                "",
                &provider_id,
                &sent_at,
            )?;
            upsert_sms_reminder_history(&conn, &message, &provider_status, &sent_at, id)?;
            get_message_log_entry(&conn, id)
        }
        Err(error) => {
            let sent_at = current_timestamp_iso(&conn);
            let id = insert_message_log(&conn, &message, "Failed", &error, "", &sent_at)?;
            upsert_sms_reminder_history(&conn, &message, "Failed", &sent_at, id)?;
            let _ = get_message_log_entry(&conn, id);
            Err(error)
        }
    }
}

#[tauri::command]
fn get_app_update_state(app: tauri::AppHandle) -> AppUpdateState {
    AppUpdateState {
        current_version: app.package_info().version.to_string(),
        configured: build_app_updater(&app).is_ok(),
    }
}

#[tauri::command]
async fn check_for_app_update(
    app: tauri::AppHandle,
    pending_update: State<'_, PendingUpdate>,
) -> Result<Option<AppUpdateMetadata>, String> {
    let update = build_app_updater(&app)?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    let metadata = update.as_ref().map(|update| AppUpdateMetadata {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone().unwrap_or_default(),
        pub_date: update.date.map(|date| date.to_string()).unwrap_or_default(),
    });

    *pending_update.0.lock().unwrap() = update;
    Ok(metadata)
}

#[tauri::command]
async fn install_app_update(pending_update: State<'_, PendingUpdate>) -> Result<(), String> {
    let Some(update) = pending_update.0.lock().unwrap().take() else {
        return Err("No pending update. Check for updates first.".to_string());
    };

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_clients(state: State<DbState>) -> Vec<serde_json::Value> {
    let conn = state.0.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, c.phone, c.email, c.address, c.company, c.notes,
         c.cloud_account_email, c.cloud_user_id, c.cloud_last_synced_at, c.cloud_sync_status,
         COUNT(DISTINCT v.id) as vehicle_count,
         MAX(jc.date_opened) as last_visit,
         COALESCE(SUM(CASE
           WHEN i.status IN ('Unpaid','Partial') THEN MAX(0, (COALESCE(jl_total.total,0) * (1 + COALESCE(i.vat_rate,20.0) / 100.0)) - CASE WHEN i.status='Partial' THEN COALESCE(i.paid_amount,0) ELSE 0 END)
           ELSE 0
         END),0) as balance
         FROM clients c
         LEFT JOIN vehicles v ON v.client_id=c.id
         LEFT JOIN job_cards jc ON jc.client_id=c.id
         LEFT JOIN invoices i ON i.job_id=jc.id
         LEFT JOIN (SELECT job_id, SUM(qty*unit_price) as total FROM job_lines GROUP BY job_id) jl_total ON jl_total.job_id=jc.id
         GROUP BY c.id ORDER BY c.name"
    ).unwrap();
    stmt.query_map([], |r| {
        Ok(serde_json::json!({
            "id": r.get::<_,i64>(0)?,
            "name": r.get::<_,String>(1)?,
            "phone": r.get::<_,String>(2).unwrap_or_default(),
            "email": r.get::<_,String>(3).unwrap_or_default(),
            "address": r.get::<_,String>(4).unwrap_or_default(),
            "company": r.get::<_,String>(5).unwrap_or_default(),
            "notes": r.get::<_,String>(6).unwrap_or_default(),
            "cloud_account_email": r.get::<_,String>(7).unwrap_or_default(),
            "cloud_user_id": r.get::<_,String>(8).unwrap_or_default(),
            "cloud_last_synced_at": r.get::<_,String>(9).unwrap_or_default(),
            "cloud_sync_status": r.get::<_,String>(10).unwrap_or_else(|_| "Local only".to_string()),
            "vehicle_count": r.get::<_,i64>(11).unwrap_or(0),
            "last_visit": r.get::<_,String>(12).unwrap_or_default(),
            "balance": r.get::<_,f64>(13).unwrap_or(0.0),
        }))
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

#[tauri::command]
fn save_client(client: Client, state: State<DbState>) -> Result<i64, String> {
    let conn = state.0.lock().unwrap();
    let cloud_account_email = client.cloud_account_email.trim().to_string();
    let cloud_user_id = client.cloud_user_id.trim().to_string();
    let cloud_last_synced_at = client.cloud_last_synced_at.trim().to_string();
    let cloud_sync_status = {
        let status = client.cloud_sync_status.trim();
        if status.is_empty() {
            if cloud_user_id.is_empty() {
                "Local only".to_string()
            } else {
                "Linked".to_string()
            }
        } else {
            status.to_string()
        }
    };

    match client.id {
        Some(id) => {
            conn.execute("UPDATE clients SET name=?1,phone=?2,email=?3,address=?4,company=?5,notes=?6,cloud_account_email=?7,cloud_user_id=?8,cloud_last_synced_at=?9,cloud_sync_status=?10 WHERE id=?11",
                params![client.name,client.phone,client.email,client.address,client.company,client.notes,cloud_account_email,cloud_user_id,cloud_last_synced_at,cloud_sync_status,id])
                .map_err(|e| e.to_string())?;
            Ok(id)
        }
        None => {
            conn.execute("INSERT INTO clients (name,phone,email,address,company,notes,cloud_account_email,cloud_user_id,cloud_last_synced_at,cloud_sync_status) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![client.name,client.phone,client.email,client.address,client.company,client.notes,cloud_account_email,cloud_user_id,cloud_last_synced_at,cloud_sync_status])
                .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        }
    }
}

#[tauri::command]
fn delete_client(id: i64, state: State<DbState>) -> Result<(), String> {
    let mut conn = state.0.lock().unwrap();
    let vehicle_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vehicles WHERE client_id=?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let job_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM job_cards WHERE client_id=?1 OR vehicle_id IN (SELECT id FROM vehicles WHERE client_id=?1)",
        params![id],
        |r| r.get(0),
    ).unwrap_or(0);
    let booking_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM bookings WHERE client_id=?1 OR vehicle_id IN (SELECT id FROM vehicles WHERE client_id=?1)",
        params![id],
        |r| r.get(0),
    ).unwrap_or(0);

    if job_count > 0 || booking_count > 0 {
        let mut refs = Vec::new();
        if job_count > 0 {
            refs.push(format!("{} job card(s)", job_count));
        }
        if booking_count > 0 {
            refs.push(format!("{} booking(s)", booking_count));
        }
        return Err(format!(
            "Cannot delete client while linked work exists: {}. Remove or reassign those records first. Owned vehicles can be deleted automatically only when no jobs or bookings reference them.",
            refs.join(", ")
        ));
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if vehicle_count > 0 {
        tx.execute("DELETE FROM vehicles WHERE client_id=?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM clients WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_vehicles(client_id: Option<i64>, state: State<DbState>) -> Vec<serde_json::Value> {
    let conn = state.0.lock().unwrap();
    let sql = match client_id {
        Some(_) => "SELECT v.*, c.name as client_name FROM vehicles v JOIN clients c ON c.id=v.client_id WHERE v.client_id=?1 ORDER BY v.registration",
        None => "SELECT v.*, c.name as client_name FROM vehicles v JOIN clients c ON c.id=v.client_id ORDER BY v.registration",
    };
    let param: i64 = client_id.unwrap_or(0);
    let mut stmt = conn.prepare(sql).unwrap();
    let rows = if client_id.is_some() {
        stmt.query_map(params![param], |r| map_vehicle(r))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    } else {
        stmt.query_map([], |r| map_vehicle(r))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    };
    rows
}

fn map_vehicle(r: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": r.get::<_,i64>(0)?,
        "client_id": r.get::<_,i64>(1)?,
        "registration": r.get::<_,String>(2).unwrap_or_default(),
        "vin": r.get::<_,String>(3).unwrap_or_default(),
        "make": r.get::<_,String>(4).unwrap_or_default(),
        "model": r.get::<_,String>(5).unwrap_or_default(),
        "year": r.get::<_,i64>(6).unwrap_or(0),
        "engine": r.get::<_,String>(7).unwrap_or_default(),
        "fuel_type": r.get::<_,String>(8).unwrap_or_default(),
        "colour": r.get::<_,String>(9).unwrap_or_default(),
        "mileage": r.get::<_,i64>(10).unwrap_or(0),
        "mot_due": r.get::<_,String>(11).unwrap_or_default(),
        "service_due": r.get::<_,String>(12).unwrap_or_default(),
        "notes": r.get::<_,String>(13).unwrap_or_default(),
        "client_name": r.get::<_,String>(14).unwrap_or_default(),
    }))
}

#[tauri::command]
fn save_vehicle(vehicle: Vehicle, state: State<DbState>) -> Result<i64, String> {
    let conn = state.0.lock().unwrap();
    match vehicle.id {
        Some(id) => {
            conn.execute("UPDATE vehicles SET client_id=?1,registration=?2,vin=?3,make=?4,model=?5,year=?6,engine=?7,fuel_type=?8,colour=?9,mileage=?10,mot_due=?11,service_due=?12,notes=?13 WHERE id=?14",
                params![vehicle.client_id,vehicle.registration,vehicle.vin,vehicle.make,vehicle.model,vehicle.year,vehicle.engine,vehicle.fuel_type,vehicle.colour,vehicle.mileage,vehicle.mot_due,vehicle.service_due,vehicle.notes,id])
                .map_err(|e| e.to_string())?;
            sync_job_cards_mileage_from_vehicle(&conn, id, vehicle.mileage)?;
            Ok(id)
        }
        None => {
            conn.execute("INSERT INTO vehicles (client_id,registration,vin,make,model,year,engine,fuel_type,colour,mileage,mot_due,service_due,notes) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                params![vehicle.client_id,vehicle.registration,vehicle.vin,vehicle.make,vehicle.model,vehicle.year,vehicle.engine,vehicle.fuel_type,vehicle.colour,vehicle.mileage,vehicle.mot_due,vehicle.service_due,vehicle.notes])
                .map_err(|e| e.to_string())?;
            let id = conn.last_insert_rowid();
            sync_job_cards_mileage_from_vehicle(&conn, id, vehicle.mileage)?;
            Ok(id)
        }
    }
}

#[tauri::command]
fn delete_vehicle(
    id: i64,
    delete_bookings: Option<bool>,
    state: State<DbState>,
) -> Result<(), String> {
    let mut conn = state.0.lock().unwrap();
    let job_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM job_cards WHERE vehicle_id=?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let booking_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM bookings WHERE vehicle_id=?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    if job_count > 0 {
        return Err(format!(
            "Cannot delete vehicle while {} job card(s) are linked. Remove or reassign those jobs first.",
            job_count
        ));
    }

    if booking_count > 0 && delete_bookings != Some(true) {
        return Err(format!(
            "This vehicle has {} booking(s). Confirm deleting those bookings first.",
            booking_count
        ));
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if booking_count > 0 {
        tx.execute("DELETE FROM bookings WHERE vehicle_id=?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM vehicles WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_job_cards(state: State<DbState>) -> Vec<serde_json::Value> {
    let conn = state.0.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT jc.id, jc.client_id, jc.vehicle_id, COALESCE(jc.booking_id, 0),
                    jc.status, jc.complaint, jc.findings, jc.work_performed, jc.mechanic,
                    jc.mileage_in, jc.mileage_out, jc.est_completion, jc.internal_notes,
                    jc.customer_notes, jc.date_opened,
                    COALESCE(c.name, '') as client_name, COALESCE(v.registration, ''),
                    COALESCE(v.make, ''), COALESCE(v.model, ''),
                    COALESCE(b.date, ''), COALESCE(b.time, ''), COALESCE(b.reason, ''),
                    COALESCE(SUM(jl.qty*jl.unit_price),0) as subtotal
             FROM job_cards jc
             LEFT JOIN clients c ON c.id=jc.client_id
             LEFT JOIN vehicles v ON v.id=jc.vehicle_id
             LEFT JOIN bookings b ON b.id=jc.booking_id
             LEFT JOIN job_lines jl ON jl.job_id=jc.id
             GROUP BY jc.id ORDER BY jc.date_opened DESC",
        )
        .unwrap();
    stmt.query_map([], |r| {
        Ok(serde_json::json!({
            "id": r.get::<_,i64>(0)?,
            "client_id": r.get::<_,i64>(1)?,
            "vehicle_id": r.get::<_,i64>(2)?,
            "booking_id": r.get::<_,i64>(3).unwrap_or(0),
            "status": r.get::<_,String>(4).unwrap_or_default(),
            "complaint": r.get::<_,String>(5).unwrap_or_default(),
            "findings": r.get::<_,String>(6).unwrap_or_default(),
            "work_performed": r.get::<_,String>(7).unwrap_or_default(),
            "mechanic": r.get::<_,String>(8).unwrap_or_default(),
            "mileage_in": r.get::<_,i64>(9).unwrap_or(0),
            "mileage_out": r.get::<_,i64>(10).unwrap_or(0),
            "est_completion": r.get::<_,String>(11).unwrap_or_default(),
            "internal_notes": r.get::<_,String>(12).unwrap_or_default(),
            "customer_notes": r.get::<_,String>(13).unwrap_or_default(),
            "date_opened": r.get::<_,String>(14).unwrap_or_default(),
            "client_name": r.get::<_,String>(15).unwrap_or_default(),
            "registration": r.get::<_,String>(16).unwrap_or_default(),
            "make": r.get::<_,String>(17).unwrap_or_default(),
            "model": r.get::<_,String>(18).unwrap_or_default(),
            "booking_date": r.get::<_,String>(19).unwrap_or_default(),
            "booking_time": r.get::<_,String>(20).unwrap_or_default(),
            "booking_reason": r.get::<_,String>(21).unwrap_or_default(),
            "subtotal": r.get::<_,f64>(22).unwrap_or(0.0),
        }))
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

#[tauri::command]
fn save_job_card(mut job: JobCard, state: State<DbState>) -> Result<i64, String> {
    let conn = state.0.lock().unwrap();
    ensure_vehicle_belongs_to_client(&conn, job.vehicle_id, job.client_id)?;
    normalize_job_mileage_from_vehicle(&conn, &mut job)?;
    let booking_id = job.booking_id.filter(|id| *id > 0);
    if let Some(source_booking_id) = booking_id {
        let linked: Option<(i64, i64)> = conn
            .query_row(
                "SELECT client_id, vehicle_id FROM bookings WHERE id=?1",
                params![source_booking_id],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match linked {
            Some((booking_client_id, booking_vehicle_id))
                if booking_client_id == job.client_id && booking_vehicle_id == job.vehicle_id => {}
            Some(_) => {
                return Err(
                    "Selected booking does not match the job card client and vehicle.".to_string(),
                )
            }
            None => return Err("Selected booking was not found.".to_string()),
        }
    }
    match job.id {
        Some(id) => {
            conn.execute("UPDATE job_cards SET client_id=?1,vehicle_id=?2,booking_id=?3,status=?4,complaint=?5,findings=?6,work_performed=?7,mechanic=?8,mileage_in=?9,mileage_out=?10,est_completion=?11,internal_notes=?12,customer_notes=?13 WHERE id=?14",
                params![job.client_id,job.vehicle_id,booking_id,job.status,job.complaint,job.findings,job.work_performed,job.mechanic,job.mileage_in,job.mileage_out,job.est_completion,job.internal_notes,job.customer_notes,id])
                .map_err(|e| e.to_string())?;
            sync_vehicle_mileage_from_job(&conn, job.vehicle_id, job.mileage_in, &job.status)?;
            Ok(id)
        }
        None => {
            conn.execute("INSERT INTO job_cards (client_id,vehicle_id,booking_id,status,complaint,findings,work_performed,mechanic,mileage_in,mileage_out,est_completion,internal_notes,customer_notes,date_opened) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,date('now'))",
                params![job.client_id,job.vehicle_id,booking_id,job.status,job.complaint,job.findings,job.work_performed,job.mechanic,job.mileage_in,job.mileage_out,job.est_completion,job.internal_notes,job.customer_notes])
                .map_err(|e| e.to_string())?;
            let id = conn.last_insert_rowid();
            sync_vehicle_mileage_from_job(&conn, job.vehicle_id, job.mileage_in, &job.status)?;
            Ok(id)
        }
    }
}

#[tauri::command]
fn get_job_lines(job_id: i64, state: State<DbState>) -> Vec<serde_json::Value> {
    let conn = state.0.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT jl.id, jl.job_id, jl.line_type, jl.description, jl.qty, jl.unit_price,
                    jl.line_status, jl.inventory_item_id, COALESCE(ii.part_name, ''),
                    COALESCE(ii.sku, ''), COALESCE(ii.category, ''), COALESCE(ii.supplier, ''),
                    jl.inventory_stock_qty_applied
             FROM job_lines jl
             LEFT JOIN inventory_items ii ON ii.id=jl.inventory_item_id
             WHERE jl.job_id=?1
             ORDER BY jl.id",
        )
        .unwrap();
    stmt.query_map(params![job_id], |r| {
        Ok(serde_json::json!({
            "id": r.get::<_,i64>(0)?,
            "job_id": r.get::<_,i64>(1)?,
            "line_type": r.get::<_,String>(2)?,
            "description": r.get::<_,String>(3).unwrap_or_default(),
            "qty": r.get::<_,f64>(4)?,
            "unit_price": r.get::<_,f64>(5)?,
            "line_status": normalize_job_line_status(&r.get::<_,String>(6).unwrap_or_else(|_| default_job_line_status())),
            "inventory_item_id": r.get::<_, Option<i64>>(7).unwrap_or(None),
            "inventory_part_name": r.get::<_, String>(8).unwrap_or_default(),
            "inventory_sku": r.get::<_, String>(9).unwrap_or_default(),
            "inventory_category": r.get::<_, String>(10).unwrap_or_default(),
            "inventory_supplier": r.get::<_, String>(11).unwrap_or_default(),
            "inventory_stock_qty_applied": r.get::<_, f64>(12).unwrap_or(0.0),
        }))
    }).unwrap().filter_map(|r| r.ok()).collect()
}

#[tauri::command]
fn save_job_line(line: JobLine, state: State<DbState>) -> Result<i64, String> {
    let conn = state.0.lock().unwrap();
    let line_status = normalize_job_line_status(&line.line_status);
    let line_type = line.line_type.trim().to_string();
    let inventory_item_id = if line_type.eq_ignore_ascii_case("Part") {
        line.inventory_item_id.filter(|id| *id > 0)
    } else {
        None
    };
    let next_applied_qty = if inventory_item_id.is_some() {
        sanitize_stock_number(line.qty)
    } else {
        0.0
    };
    match line.id {
        Some(id) => {
            let previous = conn
                .query_row(
                    "SELECT inventory_item_id, inventory_stock_qty_applied FROM job_lines WHERE id=?1",
                    params![id],
                    |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, f64>(1).unwrap_or(0.0))),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Job line not found.".to_string())?;
            let previous_item_id = previous.0.filter(|item_id| *item_id > 0);
            let previous_applied_qty = sanitize_stock_number(previous.1);

            if previous_item_id == inventory_item_id {
                apply_job_line_inventory_delta(
                    &conn,
                    inventory_item_id,
                    next_applied_qty - previous_applied_qty,
                    "Job line quantity update",
                )?;
            } else {
                apply_job_line_inventory_delta(
                    &conn,
                    previous_item_id,
                    -previous_applied_qty,
                    "Job line inventory changed",
                )?;
                apply_job_line_inventory_delta(
                    &conn,
                    inventory_item_id,
                    next_applied_qty,
                    "Job line part used",
                )?;
            }

            conn.execute("UPDATE job_lines SET line_type=?1,description=?2,qty=?3,unit_price=?4,line_status=?5,inventory_item_id=?6,inventory_stock_qty_applied=?7 WHERE id=?8",
                params![line_type,line.description,line.qty,line.unit_price,line_status,inventory_item_id,next_applied_qty,id])
                .map_err(|e| e.to_string())?;
            Ok(id)
        }
        None => {
            apply_job_line_inventory_delta(
                &conn,
                inventory_item_id,
                next_applied_qty,
                "Job line part used",
            )?;
            conn.execute("INSERT INTO job_lines (job_id,line_type,description,qty,unit_price,line_status,inventory_item_id,inventory_stock_qty_applied) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![line.job_id,line_type,line.description,line.qty,line.unit_price,line_status,inventory_item_id,next_applied_qty])
                .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        }
    }
}

#[tauri::command]
fn delete_job_line(id: i64, state: State<DbState>) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    let previous = conn
        .query_row(
            "SELECT inventory_item_id, inventory_stock_qty_applied FROM job_lines WHERE id=?1",
            params![id],
            |r| {
                Ok((
                    r.get::<_, Option<i64>>(0)?,
                    r.get::<_, f64>(1).unwrap_or(0.0),
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((item_id, applied_qty)) = previous {
        apply_job_line_inventory_delta(
            &conn,
            item_id.filter(|id| *id > 0),
            -sanitize_stock_number(applied_qty),
            "Job line deleted",
        )?;
    }
    conn.execute("DELETE FROM job_lines WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn generate_invoice(job_id: i64, state: State<DbState>) -> Result<i64, String> {
    let conn = state.0.lock().unwrap();
    let existing: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM invoices WHERE job_id=?1",
            params![job_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if existing > 0 {
        return conn
            .query_row(
                "SELECT id FROM invoices WHERE job_id=?1",
                params![job_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string());
    }
    let num: i64 = conn
        .query_row("SELECT COALESCE(MAX(id),1000)+1 FROM invoices", [], |r| {
            r.get(0)
        })
        .unwrap_or(1001);
    let inv_num = format!("INV-{}", num);
    let settings = load_app_settings_from_conn(&conn);
    let vat_rate = invoice_vat_rate_from_settings(&settings);
    conn.execute("INSERT INTO invoices (job_id,invoice_number,date_issued,due_date,status,vat_rate) VALUES (?1,?2,date('now'),date('now','+7 days'),'Unpaid',?3)",
        params![job_id,inv_num,vat_rate]).map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
fn save_invoice(invoice: Invoice, state: State<DbState>) -> Result<i64, String> {
    let conn = state.0.lock().unwrap();
    let settings = load_app_settings_from_conn(&conn);
    let invoice_number = {
        let trimmed = invoice.invoice_number.trim();
        if trimmed.is_empty() {
            match invoice.id {
                Some(id) => format!("INV-{}", id),
                None => "INV-DRAFT".to_string(),
            }
        } else {
            trimmed.to_string()
        }
    };
    let status = match invoice.status.trim() {
        "Paid" => "Paid".to_string(),
        "Partial" => "Partial".to_string(),
        _ => "Unpaid".to_string(),
    };
    let payment_method = invoice.payment_method.trim().to_string();
    let notes = invoice.notes.trim().to_string();
    let vat_rate = invoice_vat_rate_from_settings(&settings);
    let subtotal = conn
        .query_row(
            "SELECT COALESCE(SUM(qty * unit_price),0) FROM job_lines WHERE job_id=?1",
            params![invoice.job_id],
            |r| r.get::<_, f64>(0),
        )
        .unwrap_or(0.0);
    let invoice_total = round_money(subtotal + (subtotal * vat_rate / 100.0));
    let paid_amount = match status.as_str() {
        "Paid" => invoice_total,
        "Partial" => round_money(invoice.paid_amount.clamp(0.0, invoice_total)),
        _ => 0.0,
    };

    match invoice.id {
        Some(id) => {
            conn.execute(
                "UPDATE invoices SET invoice_number=?1,date_issued=?2,due_date=?3,status=?4,payment_method=?5,paid_amount=?6,notes=?7,vat_rate=?8 WHERE id=?9",
                params![invoice_number, invoice.date_issued, invoice.due_date, status, payment_method, paid_amount, notes, vat_rate, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO invoices (job_id,invoice_number,date_issued,due_date,status,payment_method,paid_amount,notes,vat_rate) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![invoice.job_id, invoice_number, invoice.date_issued, invoice.due_date, status, payment_method, paid_amount, notes, vat_rate],
            )
            .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        }
    }
}

#[tauri::command]
fn get_invoices(state: State<DbState>) -> Vec<serde_json::Value> {
    let conn = state.0.lock().unwrap();
    let vat_rate = invoice_vat_rate_from_settings(&load_app_settings_from_conn(&conn));
    let mut stmt = conn
        .prepare(
            "SELECT i.id, i.job_id, i.invoice_number, i.date_issued, i.due_date, i.status, i.payment_method, i.paid_amount, i.notes, i.vat_rate,
         c.name as client_name, v.registration, v.make, v.model,
         COALESCE(SUM(jl.qty*jl.unit_price),0) as subtotal
         FROM invoices i
         JOIN job_cards jc ON jc.id=i.job_id
         LEFT JOIN clients c ON c.id=jc.client_id
         LEFT JOIN vehicles v ON v.id=jc.vehicle_id
         LEFT JOIN job_lines jl ON jl.job_id=jc.id
         GROUP BY i.id ORDER BY i.date_issued DESC",
        )
        .unwrap();
    stmt.query_map([], |r| {
        let subtotal: f64 = r.get::<_, f64>(14).unwrap_or(0.0);
        let vat = subtotal * vat_rate / 100.0;
        let total = subtotal + vat;
        Ok(serde_json::json!({
            "id": r.get::<_,i64>(0)?,
            "job_id": r.get::<_,i64>(1)?,
            "invoice_number": r.get::<_,String>(2).unwrap_or_default(),
            "date_issued": r.get::<_,String>(3).unwrap_or_default(),
            "due_date": r.get::<_,String>(4).unwrap_or_default(),
            "status": r.get::<_,String>(5).unwrap_or_default(),
            "payment_method": r.get::<_,String>(6).unwrap_or_default(),
            "paid_amount": round_money(r.get::<_,f64>(7).unwrap_or(0.0)),
            "notes": r.get::<_,String>(8).unwrap_or_default(),
            "vat_rate": vat_rate,
            "client_name": r.get::<_,String>(10).unwrap_or_default(),
            "registration": r.get::<_,String>(11).unwrap_or_default(),
            "make": r.get::<_,String>(12).unwrap_or_default(),
            "model": r.get::<_,String>(13).unwrap_or_default(),
            "subtotal": (subtotal * 100.0).round() / 100.0,
            "vat": (vat * 100.0).round() / 100.0,
            "total": (total * 100.0).round() / 100.0,
        }))
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

#[tauri::command]
fn mark_invoice_paid(id: i64, method: String, state: State<DbState>) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    let settings = load_app_settings_from_conn(&conn);
    let vat_rate = invoice_vat_rate_from_settings(&settings);
    let job_id: i64 = conn
        .query_row(
            "SELECT job_id FROM invoices WHERE id=?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let subtotal = conn
        .query_row(
            "SELECT COALESCE(SUM(qty * unit_price),0) FROM job_lines WHERE job_id=?1",
            params![job_id],
            |r| r.get::<_, f64>(0),
        )
        .unwrap_or(0.0);
    let paid_amount = round_money(subtotal + (subtotal * vat_rate / 100.0));
    conn.execute(
        "UPDATE invoices SET status='Paid',payment_method=?1,paid_amount=?2 WHERE id=?3",
        params![method, paid_amount, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_bookings(state: State<DbState>) -> Vec<serde_json::Value> {
    let conn = state.0.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT b.*, c.name as client_name, v.registration, v.make, v.model
         FROM bookings b
         LEFT JOIN clients c ON c.id=b.client_id
         LEFT JOIN vehicles v ON v.id=b.vehicle_id
         ORDER BY b.date, b.time",
        )
        .unwrap();
    stmt.query_map([], |r| {
        Ok(serde_json::json!({
            "id": r.get::<_,i64>(0)?,
            "client_id": r.get::<_,i64>(1)?,
            "vehicle_id": r.get::<_,i64>(2)?,
            "date": r.get::<_,String>(3).unwrap_or_default(),
            "time": r.get::<_,String>(4).unwrap_or_default(),
            "reason": r.get::<_,String>(5).unwrap_or_default(),
            "status": r.get::<_,String>(6).unwrap_or_default(),
            "notes": r.get::<_,String>(7).unwrap_or_default(),
            "client_name": r.get::<_,String>(8).unwrap_or_default(),
            "registration": r.get::<_,String>(9).unwrap_or_default(),
            "make": r.get::<_,String>(10).unwrap_or_default(),
            "model": r.get::<_,String>(11).unwrap_or_default(),
        }))
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

#[tauri::command]
fn save_booking(booking: Booking, state: State<DbState>) -> Result<i64, String> {
    let conn = state.0.lock().unwrap();
    ensure_vehicle_belongs_to_client(&conn, booking.vehicle_id, booking.client_id)?;
    match booking.id {
        Some(id) => {
            conn.execute("UPDATE bookings SET client_id=?1,vehicle_id=?2,date=?3,time=?4,reason=?5,status=?6,notes=?7 WHERE id=?8",
                params![booking.client_id,booking.vehicle_id,booking.date,booking.time,booking.reason,booking.status,booking.notes,id])
                .map_err(|e| e.to_string())?;
            Ok(id)
        }
        None => {
            conn.execute("INSERT INTO bookings (client_id,vehicle_id,date,time,reason,status,notes) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![booking.client_id,booking.vehicle_id,booking.date,booking.time,booking.reason,booking.status,booking.notes])
                .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        }
    }
}

#[tauri::command]
fn delete_booking(booking_id: i64, state: State<DbState>) -> Result<(), String> {
    let mut conn = state.0.lock().unwrap();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE job_cards SET booking_id=NULL WHERE booking_id=?1",
        params![booking_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM bookings WHERE id=?1", params![booking_id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_inventory_items(state: State<DbState>) -> Vec<serde_json::Value> {
    let conn = state.0.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT id, part_name, sku, category, supplier, quantity, minimum_stock_level, purchase_cost, sell_price, margin_percent, price_mode, notes
             FROM inventory_items ORDER BY part_name COLLATE NOCASE, sku COLLATE NOCASE",
        )
        .unwrap();
    stmt.query_map([], |r| {
        let quantity = r.get::<_, f64>(5).unwrap_or(0.0);
        let purchase_cost = r.get::<_, f64>(7).unwrap_or(0.0);
        let (sell_price, margin_percent, price_mode) = resolve_inventory_pricing(
            purchase_cost,
            r.get::<_, f64>(8).unwrap_or(0.0),
            r.get::<_, f64>(9).unwrap_or(0.0),
            &r.get::<_, String>(10)
                .unwrap_or_else(|_| default_inventory_price_mode()),
        );
        Ok(serde_json::json!({
            "id": r.get::<_, i64>(0)?,
            "part_name": r.get::<_, String>(1)?,
            "sku": r.get::<_, String>(2).unwrap_or_default(),
            "category": r.get::<_, String>(3).unwrap_or_default(),
            "supplier": r.get::<_, String>(4).unwrap_or_default(),
            "quantity": quantity,
            "minimum_stock_level": r.get::<_, f64>(6).unwrap_or(0.0),
            "purchase_cost": purchase_cost,
            "sell_price": sell_price,
            "margin_percent": margin_percent,
            "price_mode": price_mode,
            "inventory_value": ((quantity * purchase_cost) * 100.0).round() / 100.0,
            "retail_value": ((quantity * sell_price) * 100.0).round() / 100.0,
            "gross_profit_each": ((sell_price - purchase_cost) * 100.0).round() / 100.0,
            "notes": r.get::<_, String>(11).unwrap_or_default(),
        }))
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

#[tauri::command]
fn get_inventory_movements(state: State<DbState>) -> Vec<serde_json::Value> {
    let conn = state.0.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT im.id, im.inventory_item_id, im.movement_type, im.quantity, im.movement_date, im.notes,
                    COALESCE(ii.part_name, ''), COALESCE(ii.sku, '')
             FROM inventory_movements im
             LEFT JOIN inventory_items ii ON ii.id=im.inventory_item_id
             ORDER BY im.movement_date DESC, im.id DESC",
        )
        .unwrap();
    stmt.query_map([], |r| {
        Ok(serde_json::json!({
            "id": r.get::<_, i64>(0)?,
            "inventory_item_id": r.get::<_, i64>(1)?,
            "movement_type": normalize_inventory_movement_type(&r.get::<_, String>(2).unwrap_or_default()),
            "quantity": r.get::<_, f64>(3).unwrap_or(0.0),
            "movement_date": r.get::<_, String>(4).unwrap_or_default(),
            "notes": r.get::<_, String>(5).unwrap_or_default(),
            "part_name": r.get::<_, String>(6).unwrap_or_default(),
            "sku": r.get::<_, String>(7).unwrap_or_default(),
        }))
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

#[tauri::command]
fn save_inventory_item(item: InventoryItem, state: State<DbState>) -> Result<i64, String> {
    let conn = state.0.lock().unwrap();
    let part_name = item.part_name.trim().to_string();
    if part_name.is_empty() {
        return Err("Part name is required.".to_string());
    }
    let sku = item.sku.trim().to_string();
    let category = item.category.trim().to_string();
    let supplier = item.supplier.trim().to_string();
    let quantity = sanitize_stock_number(item.quantity);
    let minimum_stock_level = sanitize_stock_number(item.minimum_stock_level);
    let purchase_cost = sanitize_stock_number(item.purchase_cost);
    let (sell_price, margin_percent, price_mode) = resolve_inventory_pricing(
        purchase_cost,
        item.sell_price,
        item.margin_percent,
        &item.price_mode,
    );
    let notes = item.notes.trim().to_string();

    match item.id {
        Some(id) => {
            let previous_quantity = conn
                .query_row(
                    "SELECT quantity FROM inventory_items WHERE id=?1",
                    params![id],
                    |r| r.get::<_, f64>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Inventory item not found.".to_string())?;
            conn.execute(
                "UPDATE inventory_items
                 SET part_name=?1, sku=?2, category=?3, supplier=?4, quantity=?5, minimum_stock_level=?6, purchase_cost=?7, sell_price=?8, margin_percent=?9, price_mode=?10, notes=?11
                 WHERE id=?12",
                params![
                    part_name,
                    sku,
                    category,
                    supplier,
                    quantity,
                    minimum_stock_level,
                    purchase_cost,
                    sell_price,
                    margin_percent,
                    price_mode,
                    notes,
                    id
                ],
            )
            .map_err(|e| e.to_string())?;
            let adjustment = sanitize_stock_delta(quantity - previous_quantity);
            if adjustment.abs() > f64::EPSILON {
                insert_inventory_movement(
                    &conn,
                    id,
                    "Adjustment",
                    adjustment,
                    "Manual inventory edit",
                )?;
            }
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO inventory_items (part_name, sku, category, supplier, quantity, minimum_stock_level, purchase_cost, sell_price, margin_percent, price_mode, notes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    part_name,
                    sku,
                    category,
                    supplier,
                    quantity,
                    minimum_stock_level,
                    purchase_cost,
                    sell_price,
                    margin_percent,
                    price_mode,
                    notes
                ],
            )
            .map_err(|e| e.to_string())?;
            let id = conn.last_insert_rowid();
            if quantity.abs() > f64::EPSILON {
                insert_inventory_movement(&conn, id, "Adjustment", quantity, "Opening stock")?;
            }
            Ok(id)
        }
    }
}

#[tauri::command]
fn adjust_inventory_stock(
    movement: InventoryMovement,
    state: State<DbState>,
) -> Result<i64, String> {
    let conn = state.0.lock().unwrap();
    let item_id = movement.inventory_item_id;
    let current_quantity = conn
        .query_row(
            "SELECT quantity FROM inventory_items WHERE id=?1",
            params![item_id],
            |r| r.get::<_, f64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Inventory item not found.".to_string())?;

    let movement_type = normalize_inventory_movement_type(&movement.movement_type);
    let raw_quantity = sanitize_stock_delta(movement.quantity);
    let delta = match movement_type.as_str() {
        "Stock Out" => -raw_quantity.abs(),
        "Adjustment" => raw_quantity,
        _ => raw_quantity.abs(),
    };
    if delta.abs() <= f64::EPSILON {
        return Err("Enter a stock quantity to record.".to_string());
    }
    let next_quantity = sanitize_stock_delta(current_quantity + delta);
    if next_quantity < 0.0 {
        return Err("Stock cannot go below zero.".to_string());
    }

    conn.execute(
        "UPDATE inventory_items SET quantity=?1 WHERE id=?2",
        params![next_quantity, item_id],
    )
    .map_err(|e| e.to_string())?;

    let display_quantity = if movement_type == "Adjustment" {
        delta
    } else {
        delta.abs()
    };
    insert_inventory_movement(
        &conn,
        item_id,
        &movement_type,
        display_quantity,
        &movement.notes,
    )
}

#[tauri::command]
fn delete_inventory_item(id: i64, state: State<DbState>) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    conn.execute("DELETE FROM inventory_items WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_cloud_account_status(state: State<DbState>) -> CloudAccountStatus {
    let conn = state.0.lock().unwrap();
    let settings = load_app_settings_from_conn(&conn);
    cloud_account_status_from_session(
        &load_remembered_cloud_session_from_conn(&conn),
        Some(&settings),
    )
}

#[tauri::command]
fn get_supabase_auth_session(
    state: State<DbState>,
) -> Result<Option<StoredSupabaseAuthSession>, String> {
    let conn = state.0.lock().unwrap();
    let session = match ensure_active_cloud_session(&conn) {
        Ok(session) => session,
        Err(_) => return Ok(None),
    };

    if session.user_id.trim().is_empty()
        || session.access_token.trim().is_empty()
        || session.refresh_token.trim().is_empty()
    {
        return Ok(None);
    }

    Ok(Some(StoredSupabaseAuthSession {
        account_email: session.account_email,
        user_id: session.user_id,
        access_token: session.access_token,
        refresh_token: session.refresh_token,
    }))
}

#[tauri::command]
fn save_supabase_auth_session(
    session: SupabaseAuthSessionPayload,
    state: State<DbState>,
) -> Result<CloudAccountStatus, String> {
    let conn = state.0.lock().unwrap();
    let settings = load_app_settings_from_conn(&conn);
    ensure_cloud_configured(Some(&settings))?;

    let user_id = session.user_id.trim().to_string();
    let access_token = session.access_token.trim().to_string();
    let refresh_token = session.refresh_token.trim().to_string();
    if user_id.is_empty() || access_token.is_empty() || refresh_token.is_empty() {
        return Err("Account service did not return a complete auth session.".to_string());
    }

    let current = load_cloud_session_from_conn(&conn);
    reset_local_data_for_account_switch(&conn, &user_id)?;
    let cloud_session = CloudSession {
        account_email: session.account_email.trim().to_string(),
        user_id,
        access_token,
        refresh_token,
        last_synced_at: if current.user_id.trim() == session.user_id.trim() {
            current.last_synced_at
        } else {
            String::new()
        },
        session_expires_at: cloud_session_expiry_from_payload(&session),
    };
    save_cloud_session_to_conn(&conn, &cloud_session)?;

    Ok(cloud_account_status_from_session(
        &load_cloud_session_from_conn(&conn),
        Some(&settings),
    ))
}

#[tauri::command]
fn clear_supabase_auth_session(state: State<DbState>) -> Result<CloudAccountStatus, String> {
    let conn = state.0.lock().unwrap();
    let settings = load_app_settings_from_conn(&conn);
    clear_local_account_data(&conn)?;
    clear_cloud_session_in_conn(&conn)?;

    Ok(cloud_account_status_from_session(
        &load_cloud_session_from_conn(&conn),
        Some(&settings),
    ))
}

#[tauri::command]
fn sign_up_cloud_account(
    email: String,
    password: String,
    state: State<DbState>,
) -> Result<CloudAuthResult, String> {
    let settings = {
        let conn = state.0.lock().unwrap();
        load_app_settings_from_conn(&conn)
    };
    let config = ensure_cloud_configured(Some(&settings))?;

    let response = cloud_auth_headers(
        http_client().post(format!("{}/auth/v1/signup", config.supabase_url)),
        &config,
    )
    .json(&json!({
        "email": email.trim(),
        "password": password,
        "data": { "app": "garage-crm" }
    }))
    .send()
    .map_err(|e| format!("Failed to reach account service: {}", e))?;
    let response_json = parse_response_json(response).map_err(normalize_cloud_auth_error)?;
    let (user_id, account_email) = user_identity_from_auth_response(&response_json)?;
    let access_token = value_string(&response_json, &["access_token"]).unwrap_or_default();
    let refresh_token = value_string(&response_json, &["refresh_token"]).unwrap_or_default();

    let conn = state.0.lock().unwrap();
    if !access_token.is_empty() && !refresh_token.is_empty() {
        let session = session_from_auth_response(&response_json)?;
        reset_local_data_for_account_switch(&conn, &session.user_id)?;
        save_cloud_session_to_conn(&conn, &session)?;
        Ok(CloudAuthResult {
            status: cloud_account_status_from_session(
                &load_cloud_session_from_conn(&conn),
                Some(&settings),
            ),
            signed_in: true,
            requires_email_confirmation: false,
            message: "Account created. You are now signed in.".to_string(),
        })
    } else {
        clear_cloud_session_in_conn(&conn)?;
        Ok(CloudAuthResult {
            status: cloud_account_status_from_session(
                &load_cloud_session_from_conn(&conn),
                Some(&settings),
            ),
            signed_in: false,
            requires_email_confirmation: true,
            message: format!(
                "Account created for {}. Open the email, confirm it, then log in.",
                if account_email.is_empty() {
                    user_id
                } else {
                    account_email
                }
            ),
        })
    }
}

#[tauri::command]
fn sign_in_cloud_account(
    email: String,
    password: String,
    state: State<DbState>,
) -> Result<CloudAuthResult, String> {
    let settings = {
        let conn = state.0.lock().unwrap();
        load_app_settings_from_conn(&conn)
    };
    let config = ensure_cloud_configured(Some(&settings))?;

    let response = cloud_auth_headers(
        http_client().post(format!(
            "{}/auth/v1/token?grant_type=password",
            config.supabase_url
        )),
        &config,
    )
    .json(&json!({
        "email": email.trim(),
        "password": password
    }))
    .send()
    .map_err(|e| format!("Failed to reach account service: {}", e))?;
    let response_json = parse_response_json(response).map_err(normalize_cloud_auth_error)?;
    let session = session_from_auth_response(&response_json)?;

    let conn = state.0.lock().unwrap();
    reset_local_data_for_account_switch(&conn, &session.user_id)?;
    save_cloud_session_to_conn(&conn, &session)?;
    Ok(CloudAuthResult {
        status: cloud_account_status_from_session(
            &load_cloud_session_from_conn(&conn),
            Some(&settings),
        ),
        signed_in: true,
        requires_email_confirmation: false,
        message: "Logged in successfully.".to_string(),
    })
}

#[tauri::command]
fn send_cloud_password_reset(email: String, state: State<DbState>) -> Result<(), String> {
    let email = email.trim().to_string();
    if email.is_empty() {
        return Err("Enter login first.".to_string());
    }

    let settings = {
        let conn = state.0.lock().unwrap();
        load_app_settings_from_conn(&conn)
    };
    let config = ensure_cloud_configured(Some(&settings))?;

    let response = cloud_auth_headers(
        http_client().post(format!("{}/auth/v1/recover", config.supabase_url)),
        &config,
    )
    .json(&json!({ "email": email }))
    .send()
    .map_err(|e| format!("Failed to reach account service: {}", e))?;
    let _ = parse_response_json(response).map_err(normalize_cloud_auth_error)?;
    Ok(())
}

#[tauri::command]
fn sign_out_cloud_account(state: State<DbState>) -> Result<(), String> {
    let settings = {
        let conn = state.0.lock().unwrap();
        load_app_settings_from_conn(&conn)
    };
    let config = ensure_cloud_configured(Some(&settings))?;
    let conn = state.0.lock().unwrap();
    let session = load_cloud_session_from_conn(&conn);
    if !session.access_token.trim().is_empty() {
        let _ = cloud_auth_headers(
            http_client().post(format!("{}/auth/v1/logout", config.supabase_url)),
            &config,
        )
        .bearer_auth(&session.access_token)
        .send();
    }
    clear_local_account_data(&conn)?;
    clear_cloud_session_in_conn(&conn)?;
    Ok(())
}

#[tauri::command]
fn sync_account_to_cloud(state: State<DbState>) -> Result<Value, String> {
    let settings = {
        let conn = state.0.lock().unwrap();
        load_app_settings_from_conn(&conn)
    };
    let config = ensure_cloud_configured(Some(&settings))?;
    let (session, snapshot) = {
        let conn = state.0.lock().unwrap();
        let session = ensure_active_cloud_session(&conn)?;
        let snapshot = build_account_snapshot(&conn)?;
        (session, snapshot)
    };

    let synced_at = snapshot
        .get("synced_at")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let garage_name = snapshot
        .get("garage")
        .and_then(|value| value.get("garage_name"))
        .and_then(Value::as_str)
        .unwrap_or("Garage CRM")
        .to_string();

    let response = cloud_rest_headers(
        http_client().post(format!(
            "{}/rest/v1/{}?on_conflict=user_id",
            config.supabase_url, SUPABASE_APP_ACCOUNTS_TABLE
        )),
        &config,
        &session.access_token,
    )
    .header(
        "Prefer",
        "resolution=merge-duplicates,return=representation",
    )
    .json(&json!({
        "user_id": session.user_id,
        "account_email": session.account_email,
        "garage_name": garage_name,
        "snapshot": snapshot,
        "synced_at": synced_at
    }))
    .send()
    .map_err(|e| format!("Failed to reach account service: {}", e))?;
    let response_json = parse_response_json(response)?;

    let mut updated_session = session.clone();
    updated_session.last_synced_at = synced_at.clone();
    {
        let conn = state.0.lock().unwrap();
        save_cloud_session_to_conn(&conn, &updated_session)?;
    }

    Ok(json!({
        "synced_at": synced_at,
        "remote": response_json
    }))
}

#[tauri::command]
fn get_cloud_remote_snapshot_status(
    state: State<DbState>,
) -> Result<CloudRemoteSnapshotStatus, String> {
    let settings = {
        let conn = state.0.lock().unwrap();
        load_app_settings_from_conn(&conn)
    };
    let config = ensure_cloud_configured(Some(&settings))?;
    let session = {
        let conn = state.0.lock().unwrap();
        ensure_active_cloud_session(&conn)?
    };

    let response = cloud_rest_headers(
        http_client().get(format!(
            "{}/rest/v1/{}?select=synced_at,updated_at,account_email&user_id=eq.{}&limit=1",
            config.supabase_url, SUPABASE_APP_ACCOUNTS_TABLE, session.user_id
        )),
        &config,
        &session.access_token,
    )
    .send()
    .map_err(|e| format!("Failed to reach account service: {}", e))?;
    let response_json = parse_response_json(response)?;
    let maybe_row = response_json
        .as_array()
        .and_then(|rows| rows.first())
        .cloned();

    let Some(row) = maybe_row else {
        return Ok(CloudRemoteSnapshotStatus {
            exists: false,
            synced_at: String::new(),
            updated_at: String::new(),
            account_email: String::new(),
        });
    };

    Ok(CloudRemoteSnapshotStatus {
        exists: true,
        synced_at: value_string(&row, &["synced_at"]).unwrap_or_default(),
        updated_at: value_string(&row, &["updated_at"]).unwrap_or_default(),
        account_email: value_string(&row, &["account_email"]).unwrap_or_default(),
    })
}

#[tauri::command]
fn restore_account_from_cloud(state: State<DbState>) -> Result<Value, String> {
    let settings = {
        let conn = state.0.lock().unwrap();
        load_app_settings_from_conn(&conn)
    };
    let config = ensure_cloud_configured(Some(&settings))?;
    let session = {
        let conn = state.0.lock().unwrap();
        ensure_active_cloud_session(&conn)?
    };

    let response = cloud_rest_headers(
        http_client().get(format!(
            "{}/rest/v1/{}?select=snapshot,synced_at,account_email&user_id=eq.{}&limit=1",
            config.supabase_url, SUPABASE_APP_ACCOUNTS_TABLE, session.user_id
        )),
        &config,
        &session.access_token,
    )
    .send()
    .map_err(|e| format!("Failed to reach account service: {}", e))?;
    let response_json = parse_response_json(response)?;
    let maybe_row = response_json
        .as_array()
        .and_then(|rows| rows.first())
        .cloned();

    let Some(row) = maybe_row else {
        let conn = state.0.lock().unwrap();
        clear_local_account_data(&conn)?;
        return Ok(json!({
            "restored": false,
            "synced_at": "",
            "message": "No cloud snapshot found for this account yet."
        }));
    };
    let snapshot = row
        .get("snapshot")
        .cloned()
        .ok_or_else(|| "Cloud snapshot payload is missing.".to_string())?;
    let synced_at = row
        .get("synced_at")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    {
        let conn = state.0.lock().unwrap();
        apply_account_snapshot(&conn, &snapshot)?;
        let mut updated_session = load_cloud_session_from_conn(&conn);
        updated_session.last_synced_at = synced_at.clone();
        save_cloud_session_to_conn(&conn, &updated_session)?;
    }

    Ok(json!({ "restored": true, "synced_at": synced_at }))
}

#[tauri::command]
fn lookup_vehicle_registration(
    registration: String,
    state: State<DbState>,
) -> Result<Value, String> {
    let registration = normalize_vehicle_registration_for_lookup(&registration);
    if registration.is_empty() {
        return Err("Enter a registration number first.".to_string());
    }

    let settings = {
        let conn = state.0.lock().unwrap();
        load_app_settings_from_conn(&conn)
    };
    let config = ensure_cloud_configured(Some(&settings))?;
    let session = {
        let conn = state.0.lock().unwrap();
        ensure_active_cloud_session(&conn)?
    };

    let response = cloud_rest_headers(
        http_client().post(format!(
            "{}/functions/v1/dvla-vehicle-lookup",
            config.supabase_url
        )),
        &config,
        &session.access_token,
    )
    .json(&json!({ "registrationNumber": registration }))
    .send()
    .map_err(|e| format!("Failed to reach DVLA lookup service: {}", e))?;

    parse_response_json_message_only(
        response,
        "DVLA lookup failed. Check the registration and try again.",
    )
}

#[tauri::command]
fn search(query: String, state: State<DbState>) -> serde_json::Value {
    let conn = state.0.lock().unwrap();
    let q = format!("%{}%", query.to_lowercase());
    let mut clients_stmt = conn
        .prepare(
            "SELECT id,name,phone FROM clients WHERE LOWER(name) LIKE ?1 OR phone LIKE ?1 LIMIT 5",
        )
        .unwrap();
    let clients: Vec<serde_json::Value> = clients_stmt.query_map(params![q], |r| {
        Ok(serde_json::json!({"type":"client","id":r.get::<_,i64>(0)?,"label":format!("{} — {}",r.get::<_,String>(1).unwrap_or_default(),r.get::<_,String>(2).unwrap_or_default())}))
    }).unwrap().filter_map(|r| r.ok()).collect();
    let mut vehs_stmt = conn.prepare("SELECT id,registration,make,model FROM vehicles WHERE LOWER(registration) LIKE ?1 OR LOWER(vin) LIKE ?1 LIMIT 5").unwrap();
    let vehicles: Vec<serde_json::Value> = vehs_stmt.query_map(params![q], |r| {
        Ok(serde_json::json!({"type":"vehicle","id":r.get::<_,i64>(0)?,"label":format!("{} — {} {}",r.get::<_,String>(1).unwrap_or_default(),r.get::<_,String>(2).unwrap_or_default(),r.get::<_,String>(3).unwrap_or_default())}))
    }).unwrap().filter_map(|r| r.ok()).collect();
    serde_json::json!({"clients": clients, "vehicles": vehicles})
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_rustls_crypto_provider();

    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }

            let db_path = resolve_db_path(app)?;
            let conn = Connection::open(&db_path).expect("Failed to open database");
            init_db(&conn);
            if !cloud_session_is_remembered(&load_cloud_session_from_conn(&conn)) {
                clear_cloud_session_in_conn(&conn)
                    .expect("Failed to clear cloud session on launch");
            }
            app.manage(DbState(Mutex::new(conn)));
            app.manage(PendingUpdate(Mutex::new(None)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_dashboard,
            get_app_settings,
            save_app_settings,
            get_message_settings,
            save_message_settings,
            get_message_log,
            send_sms_message,
            get_app_update_state,
            check_for_app_update,
            install_app_update,
            get_cloud_account_status,
            get_supabase_auth_session,
            save_supabase_auth_session,
            clear_supabase_auth_session,
            sign_up_cloud_account,
            sign_in_cloud_account,
            send_cloud_password_reset,
            sign_out_cloud_account,
            sync_account_to_cloud,
            get_cloud_remote_snapshot_status,
            restore_account_from_cloud,
            lookup_vehicle_registration,
            get_clients,
            save_client,
            delete_client,
            get_vehicles,
            save_vehicle,
            delete_vehicle,
            get_job_cards,
            save_job_card,
            get_job_lines,
            save_job_line,
            delete_job_line,
            generate_invoice,
            save_invoice,
            get_invoices,
            mark_invoice_paid,
            get_bookings,
            save_booking,
            delete_booking,
            get_inventory_items,
            get_inventory_movements,
            save_inventory_item,
            adjust_inventory_stock,
            delete_inventory_item,
            search
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn resolve_db_path<R: tauri::Runtime>(
    app: &impl Manager<R>,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let mut path = app.path().app_data_dir()?;
    fs::create_dir_all(&path)?;
    path.push("garage-crm.db");
    Ok(path)
}
