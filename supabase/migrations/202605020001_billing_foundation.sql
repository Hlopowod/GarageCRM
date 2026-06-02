create extension if not exists pgcrypto;

-- Billing foundation for Garage CRM.
-- Frontend clients may read their own billing state and edit basic garage
-- profile fields. Plan, Stripe, billing event, and usage counter mutations are
-- reserved for Supabase Edge Functions running with the service role key.

create table if not exists public.garages (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users(id) on delete cascade,
  name text not null default 'Garage CRM',
  email text,
  phone text,
  postcode text,
  country_code text not null default 'GB',
  plan text not null default 'free' check (plan in ('free', 'basic', 'ultimate')),
  subscription_status text not null default 'active',
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.plan_limits (
  plan text primary key check (plan in ('free', 'basic', 'ultimate')),
  max_vehicle_records_per_month int not null,
  max_sms_per_month int not null,
  max_vrm_checks_per_month int not null,
  max_users int not null,
  can_send_sms boolean not null,
  can_check_vrm boolean not null,
  can_use_automations boolean not null
);

create table if not exists public.usage_monthly (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references public.garages(id) on delete cascade,
  month text not null,
  vehicle_records_used int not null default 0,
  sms_used int not null default 0,
  vrm_checks_used int not null default 0,
  extra_sms_credits int not null default 0,
  extra_vrm_credits int not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (garage_id, month)
);

create table if not exists public.billing_events (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid references public.garages(id) on delete set null,
  stripe_event_id text unique,
  event_type text,
  raw_event jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

insert into public.plan_limits (
  plan,
  max_vehicle_records_per_month,
  max_sms_per_month,
  max_vrm_checks_per_month,
  max_users,
  can_send_sms,
  can_check_vrm,
  can_use_automations
) values
  ('free', 15, 0, 0, 1, false, false, false),
  ('basic', 150, 100, 50, 1, true, true, false),
  ('ultimate', 500, 300, 150, 3, true, true, true)
on conflict (plan) do update set
  max_vehicle_records_per_month = excluded.max_vehicle_records_per_month,
  max_sms_per_month = excluded.max_sms_per_month,
  max_vrm_checks_per_month = excluded.max_vrm_checks_per_month,
  max_users = excluded.max_users,
  can_send_sms = excluded.can_send_sms,
  can_check_vrm = excluded.can_check_vrm,
  can_use_automations = excluded.can_use_automations;

create or replace function public.set_billing_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists garages_set_updated_at on public.garages;
create trigger garages_set_updated_at
before update on public.garages
for each row
execute procedure public.set_billing_updated_at();

drop trigger if exists usage_monthly_set_updated_at on public.usage_monthly;
create trigger usage_monthly_set_updated_at
before update on public.usage_monthly
for each row
execute procedure public.set_billing_updated_at();

create or replace function public.create_garage_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.garages (owner_user_id, email, name)
  values (
    new.id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data ->> 'garage_name', ''), 'Garage CRM')
  )
  on conflict (owner_user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_create_garage on auth.users;
create trigger on_auth_user_created_create_garage
after insert on auth.users
for each row
execute procedure public.create_garage_for_new_user();

alter table public.garages enable row level security;
alter table public.plan_limits enable row level security;
alter table public.usage_monthly enable row level security;
alter table public.billing_events enable row level security;

drop policy if exists "garages_owner_select" on public.garages;
create policy "garages_owner_select"
on public.garages
for select
to authenticated
using ((select auth.uid()) = owner_user_id);

drop policy if exists "garages_owner_insert" on public.garages;
create policy "garages_owner_insert"
on public.garages
for insert
to authenticated
with check ((select auth.uid()) = owner_user_id);

drop policy if exists "garages_owner_profile_update" on public.garages;
create policy "garages_owner_profile_update"
on public.garages
for update
to authenticated
using ((select auth.uid()) = owner_user_id)
with check ((select auth.uid()) = owner_user_id);

drop policy if exists "plan_limits_authenticated_select" on public.plan_limits;
create policy "plan_limits_authenticated_select"
on public.plan_limits
for select
to authenticated
using (true);

drop policy if exists "usage_monthly_owner_select" on public.usage_monthly;
create policy "usage_monthly_owner_select"
on public.usage_monthly
for select
to authenticated
using (
  exists (
    select 1
    from public.garages
    where garages.id = usage_monthly.garage_id
      and garages.owner_user_id = (select auth.uid())
  )
);

-- No authenticated policies are defined for billing_events. Service role Edge
-- Functions write these rows after Stripe signature verification.

revoke all on public.garages from public, anon, authenticated;
revoke all on public.plan_limits from public, anon, authenticated;
revoke all on public.usage_monthly from public, anon, authenticated;
revoke all on public.billing_events from public, anon, authenticated;

grant select on public.garages to authenticated;
grant insert (owner_user_id, name, email, phone, postcode, country_code) on public.garages to authenticated;
grant update (name, email, phone, postcode, country_code) on public.garages to authenticated;
grant select on public.plan_limits to authenticated;
grant select on public.usage_monthly to authenticated;

grant all on public.garages to service_role;
grant all on public.plan_limits to service_role;
grant all on public.usage_monthly to service_role;
grant all on public.billing_events to service_role;

create or replace function public.billing_current_month_key()
returns text
language sql
stable
as $$
  select to_char(timezone('utc', now()), 'YYYY-MM');
$$;

create or replace function public.can_create_vehicle(p_garage_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce((
    select coalesce(u.vehicle_records_used, 0) < l.max_vehicle_records_per_month
    from public.garages g
    join public.plan_limits l on l.plan = g.plan
    left join public.usage_monthly u
      on u.garage_id = g.id
     and u.month = public.billing_current_month_key()
    where g.id = p_garage_id
      and ((select auth.uid()) is null or g.owner_user_id = (select auth.uid()))
  ), false);
$$;

create or replace function public.can_send_sms(p_garage_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce((
    select l.can_send_sms
      and coalesce(u.sms_used, 0) < (l.max_sms_per_month + coalesce(u.extra_sms_credits, 0))
    from public.garages g
    join public.plan_limits l on l.plan = g.plan
    left join public.usage_monthly u
      on u.garage_id = g.id
     and u.month = public.billing_current_month_key()
    where g.id = p_garage_id
      and ((select auth.uid()) is null or g.owner_user_id = (select auth.uid()))
  ), false);
$$;

create or replace function public.can_check_vrm(p_garage_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce((
    select l.can_check_vrm
      and coalesce(u.vrm_checks_used, 0) < (l.max_vrm_checks_per_month + coalesce(u.extra_vrm_credits, 0))
    from public.garages g
    join public.plan_limits l on l.plan = g.plan
    left join public.usage_monthly u
      on u.garage_id = g.id
     and u.month = public.billing_current_month_key()
    where g.id = p_garage_id
      and ((select auth.uid()) is null or g.owner_user_id = (select auth.uid()))
  ), false);
$$;

create or replace function public.increment_vehicle_usage(p_garage_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month text := public.billing_current_month_key();
  v_incremented boolean := false;
begin
  insert into public.usage_monthly (garage_id, month)
  values (p_garage_id, v_month)
  on conflict (garage_id, month) do nothing;

  update public.usage_monthly u
  set vehicle_records_used = u.vehicle_records_used + 1,
      updated_at = timezone('utc', now())
  from public.garages g
  join public.plan_limits l on l.plan = g.plan
  where u.garage_id = p_garage_id
    and u.month = v_month
    and g.id = p_garage_id
    and u.vehicle_records_used < l.max_vehicle_records_per_month
  returning true into v_incremented;

  if not coalesce(v_incremented, false) then
    raise exception 'vehicle_limit_reached' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.increment_sms_usage(p_garage_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month text := public.billing_current_month_key();
  v_incremented boolean := false;
begin
  insert into public.usage_monthly (garage_id, month)
  values (p_garage_id, v_month)
  on conflict (garage_id, month) do nothing;

  update public.usage_monthly u
  set sms_used = u.sms_used + 1,
      updated_at = timezone('utc', now())
  from public.garages g
  join public.plan_limits l on l.plan = g.plan
  where u.garage_id = p_garage_id
    and u.month = v_month
    and g.id = p_garage_id
    and l.can_send_sms
    and u.sms_used < (l.max_sms_per_month + u.extra_sms_credits)
  returning true into v_incremented;

  if not coalesce(v_incremented, false) then
    raise exception 'sms_limit_reached' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.increment_vrm_usage(p_garage_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month text := public.billing_current_month_key();
  v_incremented boolean := false;
begin
  insert into public.usage_monthly (garage_id, month)
  values (p_garage_id, v_month)
  on conflict (garage_id, month) do nothing;

  update public.usage_monthly u
  set vrm_checks_used = u.vrm_checks_used + 1,
      updated_at = timezone('utc', now())
  from public.garages g
  join public.plan_limits l on l.plan = g.plan
  where u.garage_id = p_garage_id
    and u.month = v_month
    and g.id = p_garage_id
    and l.can_check_vrm
    and u.vrm_checks_used < (l.max_vrm_checks_per_month + u.extra_vrm_credits)
  returning true into v_incremented;

  if not coalesce(v_incremented, false) then
    raise exception 'vrm_limit_reached' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.billing_current_month_key() from public;
revoke all on function public.can_create_vehicle(uuid) from public;
revoke all on function public.can_send_sms(uuid) from public;
revoke all on function public.can_check_vrm(uuid) from public;
revoke all on function public.increment_vehicle_usage(uuid) from public;
revoke all on function public.increment_sms_usage(uuid) from public;
revoke all on function public.increment_vrm_usage(uuid) from public;

grant execute on function public.billing_current_month_key() to authenticated, service_role;
grant execute on function public.can_create_vehicle(uuid) to authenticated, service_role;
grant execute on function public.can_send_sms(uuid) to authenticated, service_role;
grant execute on function public.can_check_vrm(uuid) to authenticated, service_role;
grant execute on function public.increment_vehicle_usage(uuid) to service_role;
grant execute on function public.increment_sms_usage(uuid) to service_role;
grant execute on function public.increment_vrm_usage(uuid) to service_role;
