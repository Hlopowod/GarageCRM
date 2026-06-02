-- Backend-only free full-access accounts.
-- Add rows to admin_accounts manually from Supabase SQL/service role.
-- Frontend users cannot read or write this table.

create table if not exists public.admin_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text,
  notes text,
  enabled boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists admin_accounts_set_updated_at on public.admin_accounts;
create trigger admin_accounts_set_updated_at
before update on public.admin_accounts
for each row
execute procedure public.set_billing_updated_at();

alter table public.admin_accounts enable row level security;

revoke all on public.admin_accounts from public, anon, authenticated;
grant all on public.admin_accounts to service_role;

create or replace function public.is_current_user_admin_account()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((
    select true
    from public.admin_accounts a
    where a.user_id = (select auth.uid())
      and a.enabled
    limit 1
  ), false);
$$;

create or replace function public.is_admin_account_for_garage(p_garage_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.garages g
    join public.admin_accounts a
      on a.user_id = g.owner_user_id
     and a.enabled
    where g.id = p_garage_id
      and ((select auth.uid()) is null or g.owner_user_id = (select auth.uid()))
  );
$$;

create or replace function public.can_create_vehicle(p_garage_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce((
    select public.is_admin_account_for_garage(g.id)
      or coalesce(u.vehicle_records_used, 0) < l.max_vehicle_records_per_month
    from public.garages g
    join public.plan_limits l on l.plan = public.billing_effective_plan(g.id)
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
    select public.is_admin_account_for_garage(g.id)
      or (
        l.can_send_sms
        and coalesce(u.sms_used, 0) < (l.max_sms_per_month + coalesce(u.extra_sms_credits, 0))
      )
    from public.garages g
    join public.plan_limits l on l.plan = public.billing_effective_plan(g.id)
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
    select public.is_admin_account_for_garage(g.id)
      or (
        l.can_check_vrm
        and coalesce(u.vrm_checks_used, 0) < (l.max_vrm_checks_per_month + coalesce(u.extra_vrm_credits, 0))
      )
    from public.garages g
    join public.plan_limits l on l.plan = public.billing_effective_plan(g.id)
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
  v_is_admin boolean := public.is_admin_account_for_garage(p_garage_id);
begin
  insert into public.usage_monthly (garage_id, month)
  values (p_garage_id, v_month)
  on conflict (garage_id, month) do nothing;

  update public.usage_monthly u
  set vehicle_records_used = u.vehicle_records_used + 1,
      updated_at = timezone('utc', now())
  from public.garages g
  join public.plan_limits l on l.plan = public.billing_effective_plan(g.id)
  where u.garage_id = p_garage_id
    and u.month = v_month
    and g.id = p_garage_id
    and (v_is_admin or u.vehicle_records_used < l.max_vehicle_records_per_month)
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
  v_is_admin boolean := public.is_admin_account_for_garage(p_garage_id);
begin
  insert into public.usage_monthly (garage_id, month)
  values (p_garage_id, v_month)
  on conflict (garage_id, month) do nothing;

  update public.usage_monthly u
  set sms_used = u.sms_used + 1,
      updated_at = timezone('utc', now())
  from public.garages g
  join public.plan_limits l on l.plan = public.billing_effective_plan(g.id)
  where u.garage_id = p_garage_id
    and u.month = v_month
    and g.id = p_garage_id
    and (
      v_is_admin
      or (l.can_send_sms and u.sms_used < (l.max_sms_per_month + u.extra_sms_credits))
    )
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
  v_is_admin boolean := public.is_admin_account_for_garage(p_garage_id);
begin
  insert into public.usage_monthly (garage_id, month)
  values (p_garage_id, v_month)
  on conflict (garage_id, month) do nothing;

  update public.usage_monthly u
  set vrm_checks_used = u.vrm_checks_used + 1,
      updated_at = timezone('utc', now())
  from public.garages g
  join public.plan_limits l on l.plan = public.billing_effective_plan(g.id)
  where u.garage_id = p_garage_id
    and u.month = v_month
    and g.id = p_garage_id
    and (
      v_is_admin
      or (l.can_check_vrm and u.vrm_checks_used < (l.max_vrm_checks_per_month + u.extra_vrm_credits))
    )
  returning true into v_incremented;

  if not coalesce(v_incremented, false) then
    raise exception 'vrm_limit_reached' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.is_current_user_admin_account() from public;
revoke all on function public.is_admin_account_for_garage(uuid) from public;

grant execute on function public.is_current_user_admin_account() to authenticated, service_role;
grant execute on function public.is_admin_account_for_garage(uuid) to authenticated, service_role;
grant execute on function public.can_create_vehicle(uuid) to authenticated, service_role;
grant execute on function public.can_send_sms(uuid) to authenticated, service_role;
grant execute on function public.can_check_vrm(uuid) to authenticated, service_role;
grant execute on function public.increment_vehicle_usage(uuid) to service_role;
grant execute on function public.increment_sms_usage(uuid) to service_role;
grant execute on function public.increment_vrm_usage(uuid) to service_role;
