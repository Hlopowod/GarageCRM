create table if not exists public.garage_account_snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  account_email text not null unique,
  garage_name text,
  snapshot jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create or replace function public.set_garage_account_snapshots_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists garage_account_snapshots_set_updated_at on public.garage_account_snapshots;

create trigger garage_account_snapshots_set_updated_at
before update on public.garage_account_snapshots
for each row
execute procedure public.set_garage_account_snapshots_updated_at();

alter table public.garage_account_snapshots enable row level security;

drop policy if exists "garage_account_snapshots_owner_select" on public.garage_account_snapshots;
create policy "garage_account_snapshots_owner_select"
on public.garage_account_snapshots
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "garage_account_snapshots_owner_insert" on public.garage_account_snapshots;
create policy "garage_account_snapshots_owner_insert"
on public.garage_account_snapshots
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "garage_account_snapshots_owner_update" on public.garage_account_snapshots;
create policy "garage_account_snapshots_owner_update"
on public.garage_account_snapshots
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop function if exists public.reserve_dvla_lookup(uuid, date, integer);
drop table if exists public.dvla_lookup_usage;
drop function if exists public.set_updated_at_utc();

create table if not exists public.dvla_vehicle_cache (
  registration text primary key,
  payload jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default timezone('utc', now())
);

alter table public.dvla_vehicle_cache enable row level security;

create table if not exists public.sms_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  sms_enabled boolean not null default false,
  auto_booking_sms boolean not null default false,
  auto_mot_reminders boolean not null default false,
  auto_service_reminders boolean not null default false,
  auto_job_completed_sms boolean not null default false,
  manual_sms_enabled boolean not null default true,
  garage_name text not null default '',
  garage_phone text not null default '',
  reminder_30_days boolean not null default true,
  reminder_14_days boolean not null default true,
  reminder_7_days boolean not null default true,
  reminder_due_today boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.sms_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  template_key text not null,
  message_body text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, template_key)
);

create table if not exists public.sms_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  customer_id bigint,
  vehicle_id bigint,
  booking_id bigint,
  job_card_id bigint,
  reminder_type text,
  phone_number text not null,
  message_body text not null,
  status text not null default 'pending' check (status in ('sent', 'failed', 'pending', 'queued')),
  provider text not null default 'twilio',
  provider_message_id text,
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.sms_reminder_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vehicle_id bigint,
  customer_id bigint,
  reminder_type text not null check (reminder_type in ('MOT', 'SERVICE')),
  due_date date not null,
  reminder_stage text not null check (reminder_stage in ('30_days', '14_days', '7_days', 'due_today')),
  sent_at timestamptz,
  status text not null default 'pending',
  created_at timestamptz not null default timezone('utc', now()),
  unique (user_id, vehicle_id, customer_id, reminder_type, due_date, reminder_stage)
);

alter table public.sms_settings enable row level security;
alter table public.sms_templates enable row level security;
alter table public.sms_logs enable row level security;
alter table public.sms_reminder_history enable row level security;

drop policy if exists "sms_settings_owner_all" on public.sms_settings;
create policy "sms_settings_owner_all"
on public.sms_settings
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "sms_templates_owner_all" on public.sms_templates;
create policy "sms_templates_owner_all"
on public.sms_templates
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "sms_logs_owner_all" on public.sms_logs;
create policy "sms_logs_owner_all"
on public.sms_logs
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "sms_reminder_history_owner_all" on public.sms_reminder_history;
create policy "sms_reminder_history_owner_all"
on public.sms_reminder_history
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
