create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default timezone('utc', now())
);

insert into public.profiles (id, email, full_name, role, created_at)
select
  u.id,
  u.email,
  nullif(u.raw_user_meta_data ->> 'full_name', ''),
  case when exists (
    select 1
    from public.admin_accounts a
    where a.user_id = u.id
      and a.enabled
  ) then 'admin' else 'user' end,
  coalesce(u.created_at, timezone('utc', now()))
from auth.users u
on conflict (id) do update set
  email = coalesce(excluded.email, public.profiles.email),
  role = case when excluded.role = 'admin' then 'admin' else public.profiles.role end;

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    'user'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_create_profile on auth.users;
create trigger on_auth_user_created_create_profile
after insert on auth.users
for each row
execute procedure public.create_profile_for_new_user();

create or replace function public.is_admin_profile(p_user_id uuid default null)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((
    select true
    from public.profiles p
    where p.id = coalesce(p_user_id, (select auth.uid()))
      and p.role = 'admin'
    limit 1
  ), false);
$$;

create or replace function public.is_current_user_admin_account()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.is_admin_profile((select auth.uid()));
$$;

alter table public.profiles enable row level security;

drop policy if exists "profiles_self_or_admin_select" on public.profiles;
create policy "profiles_self_or_admin_select"
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id or public.is_admin_profile());

drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update"
on public.profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

revoke all on public.profiles from public, anon, authenticated;
grant select on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant all on public.profiles to service_role;

drop policy if exists "garage_account_snapshots_admin_select" on public.garage_account_snapshots;
create policy "garage_account_snapshots_admin_select"
on public.garage_account_snapshots
for select
to authenticated
using (public.is_admin_profile());

drop policy if exists "garages_admin_select" on public.garages;
create policy "garages_admin_select"
on public.garages
for select
to authenticated
using (public.is_admin_profile());

drop policy if exists "usage_monthly_admin_select" on public.usage_monthly;
create policy "usage_monthly_admin_select"
on public.usage_monthly
for select
to authenticated
using (public.is_admin_profile());

drop policy if exists "billing_events_admin_select" on public.billing_events;
create policy "billing_events_admin_select"
on public.billing_events
for select
to authenticated
using (public.is_admin_profile());

grant select on public.billing_events to authenticated;

create or replace function public.jsonb_array_safe(value jsonb)
returns jsonb
language sql
immutable
as $$
  select case when jsonb_typeof(value) = 'array' then value else '[]'::jsonb end;
$$;

create or replace function public.jsonb_number_safe(value text)
returns numeric
language sql
immutable
as $$
  select case
    when coalesce(value, '') ~ '^[0-9]+(\.[0-9]+)?$' then value::numeric
    else 0
  end;
$$;

create or replace function public.get_admin_dashboard_stats()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_today date := timezone('utc', now())::date;
  v_month_start timestamptz := date_trunc('month', timezone('utc', now()));
  v_30_days_start date := (timezone('utc', now())::date - 29);
  v_stats jsonb;
begin
  if not public.is_admin_profile((select auth.uid())) then
    raise exception 'admin_access_required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'totalUsers', (select count(*) from public.profiles),
    'usersToday', (
      select count(*)
      from public.profiles
      where created_at >= v_today::timestamptz
    ),
    'usersThisMonth', (
      select count(*)
      from public.profiles
      where created_at >= v_month_start
    ),
    'totalGarages', (
      select count(*)
      from public.garages
    ),
    'activeGarages', (
      select count(*)
      from public.garages
      where coalesce(subscription_status, 'active') in ('active', 'trialing')
    ),
    'totalCustomers', (
      select coalesce(sum(jsonb_array_length(public.jsonb_array_safe(snapshot -> 'clients'))), 0)
      from public.garage_account_snapshots
    ),
    'totalVehicles', (
      select coalesce(sum(jsonb_array_length(public.jsonb_array_safe(snapshot -> 'vehicles'))), 0)
      from public.garage_account_snapshots
    ),
    'totalJobs', (
      select coalesce(sum(jsonb_array_length(public.jsonb_array_safe(snapshot -> 'job_cards'))), 0)
      from public.garage_account_snapshots
    ),
    'totalInvoices', (
      select coalesce(sum(jsonb_array_length(public.jsonb_array_safe(snapshot -> 'invoices'))), 0)
      from public.garage_account_snapshots
    ),
    'monthlyRevenue', (
      select coalesce(sum(public.jsonb_number_safe(invoice ->> 'paid_amount')), 0)
      from public.garage_account_snapshots s
      cross join lateral jsonb_array_elements(public.jsonb_array_safe(s.snapshot -> 'invoices')) invoice
      where coalesce(nullif(invoice ->> 'date_issued', ''), nullif(invoice ->> 'paid_at', ''), '') >= to_char(v_month_start, 'YYYY-MM-DD')
    ),
    'activeSubscriptions', (
      select count(*)
      from public.garages
      where coalesce(subscription_status, '') in ('active', 'trialing')
        and coalesce(plan, 'free') <> 'free'
    ),
    'newUsersByDay', (
      select coalesce(jsonb_agg(jsonb_build_object('date', day::text, 'count', count) order by day), '[]'::jsonb)
      from (
        select d.day, count(p.id)::int as count
        from generate_series(v_30_days_start, v_today, interval '1 day') d(day)
        left join public.profiles p
          on p.created_at::date = d.day
        group by d.day
      ) rows
    ),
    'jobsByDay', (
      select coalesce(jsonb_agg(jsonb_build_object('date', day::text, 'count', count) order by day), '[]'::jsonb)
      from (
        select d.day, count(job)::int as count
        from generate_series(v_30_days_start, v_today, interval '1 day') d(day)
        left join public.garage_account_snapshots s on true
        left join lateral jsonb_array_elements(public.jsonb_array_safe(s.snapshot -> 'job_cards')) job
          on coalesce(nullif(job ->> 'date_opened', ''), '') = d.day::text
        group by d.day
      ) rows
    ),
    'revenueByMonth', (
      select coalesce(jsonb_agg(jsonb_build_object('month', month::text, 'revenue', revenue) order by month), '[]'::jsonb)
      from (
        select to_char(d.month, 'YYYY-MM') as month, coalesce(sum(public.jsonb_number_safe(invoice ->> 'paid_amount')), 0) as revenue
        from generate_series(date_trunc('month', timezone('utc', now())) - interval '5 months', date_trunc('month', timezone('utc', now())), interval '1 month') d(month)
        left join public.garage_account_snapshots s on true
        left join lateral jsonb_array_elements(public.jsonb_array_safe(s.snapshot -> 'invoices')) invoice
          on left(coalesce(nullif(invoice ->> 'date_issued', ''), nullif(invoice ->> 'paid_at', ''), ''), 7) = to_char(d.month, 'YYYY-MM')
        group by d.month
      ) rows
    ),
    'usersByRole', (
      select coalesce(jsonb_agg(jsonb_build_object('role', role, 'count', count) order by role), '[]'::jsonb)
      from (
        select role, count(*)::int as count
        from public.profiles
        group by role
      ) rows
    ),
    'recentUsers', (
      select coalesce(jsonb_agg(row_to_json(rows) order by rows.created_at desc), '[]'::jsonb)
      from (
        select full_name, email, role, created_at
        from public.profiles
        order by created_at desc
        limit 10
      ) rows
    ),
    'recentBusinesses', (
      select coalesce(jsonb_agg(row_to_json(rows) order by rows.created_at desc), '[]'::jsonb)
      from (
        select
          g.name as business_name,
          coalesce(g.email, p.email) as owner_email,
          g.created_at,
          coalesce(g.subscription_status, 'active') as status
        from public.garages g
        left join public.profiles p on p.id = g.owner_user_id
        order by g.created_at desc
        limit 10
      ) rows
    ),
    'recentPayments', (
      select coalesce(jsonb_agg(row_to_json(rows) order by rows.created_at desc), '[]'::jsonb)
      from (
        select
          coalesce(g.name, p.email, 'Unknown customer') as customer,
          g.plan,
          null::numeric as amount,
          coalesce(g.subscription_status, 'unknown') as status,
          coalesce(g.current_period_end, g.updated_at, g.created_at) as created_at
        from public.garages g
        left join public.profiles p on p.id = g.owner_user_id
        where g.stripe_customer_id is not null
           or coalesce(g.plan, 'free') <> 'free'
        order by coalesce(g.current_period_end, g.updated_at, g.created_at) desc
        limit 10
      ) rows
    )
  )
  into v_stats;

  return v_stats;
end;
$$;

revoke all on function public.is_admin_profile(uuid) from public;
revoke all on function public.is_current_user_admin_account() from public;
revoke all on function public.get_admin_dashboard_stats() from public;

grant execute on function public.is_admin_profile(uuid) to authenticated, service_role;
grant execute on function public.is_current_user_admin_account() to authenticated, service_role;
grant execute on function public.get_admin_dashboard_stats() to authenticated, service_role;
