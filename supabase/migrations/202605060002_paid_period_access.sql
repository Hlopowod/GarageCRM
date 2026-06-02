-- Keep paid entitlements until Stripe current_period_end even after cancellation.
-- This protects users who cancel renewal but have already paid for the current month.

create or replace function public.billing_effective_plan(p_garage_id uuid)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((
    select case
      when g.plan = 'pit_stop' then 'pit_stop'
      when g.subscription_status in ('active', 'trialing') then g.plan
      when g.current_period_end is not null and g.current_period_end > now() then g.plan
      else 'pit_stop'
    end
    from public.garages g
    where g.id = p_garage_id
      and ((select auth.uid()) is null or g.owner_user_id = (select auth.uid()))
  ), 'pit_stop');
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
    select l.can_send_sms
      and coalesce(u.sms_used, 0) < (l.max_sms_per_month + coalesce(u.extra_sms_credits, 0))
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
    select l.can_check_vrm
      and coalesce(u.vrm_checks_used, 0) < (l.max_vrm_checks_per_month + coalesce(u.extra_vrm_credits, 0))
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
  join public.plan_limits l on l.plan = public.billing_effective_plan(g.id)
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
  join public.plan_limits l on l.plan = public.billing_effective_plan(g.id)
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

revoke all on function public.billing_effective_plan(uuid) from public;
grant execute on function public.billing_effective_plan(uuid) to authenticated, service_role;
