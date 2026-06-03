create table if not exists public.referral_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  referrer_name text not null,
  referrer_email text,
  commission_percent numeric(5,2) not null default 20 check (commission_percent >= 0 and commission_percent <= 100),
  payout_months int not null default 3 check (payout_months >= 1 and payout_months <= 36),
  status text not null default 'active' check (status in ('active', 'paused')),
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.referral_attributions (
  id uuid primary key default gen_random_uuid(),
  referral_code_id uuid not null references public.referral_codes(id) on delete restrict,
  code text not null,
  user_id uuid references auth.users(id) on delete set null,
  garage_id uuid not null references public.garages(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  first_checkout_session_id text,
  attributed_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  unique (garage_id),
  unique (first_checkout_session_id)
);

create table if not exists public.referral_commissions (
  id uuid primary key default gen_random_uuid(),
  referral_code_id uuid not null references public.referral_codes(id) on delete restrict,
  attribution_id uuid not null references public.referral_attributions(id) on delete cascade,
  garage_id uuid not null references public.garages(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  stripe_invoice_id text not null unique,
  stripe_subscription_id text,
  stripe_customer_id text,
  invoice_amount_cents int not null default 0,
  currency text not null default 'gbp',
  commission_percent numeric(5,2) not null,
  commission_amount_cents int not null default 0,
  payout_month_index int not null default 1 check (payout_month_index >= 1),
  invoice_created_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  status text not null default 'pending' check (status in ('pending', 'approved', 'paid', 'void')),
  paid_at timestamptz,
  paid_by uuid references auth.users(id) on delete set null,
  notes text,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists referral_codes_status_idx on public.referral_codes (status);
create index if not exists referral_attributions_code_idx on public.referral_attributions (referral_code_id);
create index if not exists referral_commissions_code_idx on public.referral_commissions (referral_code_id);
create index if not exists referral_commissions_status_idx on public.referral_commissions (status);
create index if not exists referral_commissions_created_idx on public.referral_commissions (created_at desc);

drop trigger if exists referral_codes_set_updated_at on public.referral_codes;
create trigger referral_codes_set_updated_at
before update on public.referral_codes
for each row
execute procedure public.set_billing_updated_at();

create or replace function public.normalize_referral_code(value text)
returns text
language sql
immutable
as $$
  select upper(regexp_replace(trim(coalesce(value, '')), '\s+', '', 'g'));
$$;

create or replace function public.ensure_admin_referral_access()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin_profile((select auth.uid())) then
    raise exception 'admin_access_required' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.get_admin_referrals()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_stats jsonb;
begin
  perform public.ensure_admin_referral_access();

  select jsonb_build_object(
    'summary', jsonb_build_object(
      'totalCodes', (select count(*) from public.referral_codes),
      'activeCodes', (select count(*) from public.referral_codes where status = 'active'),
      'attributedGarages', (select count(*) from public.referral_attributions),
      'referralRevenueCents', (select coalesce(sum(invoice_amount_cents), 0) from public.referral_commissions),
      'pendingCommissionCents', (
        select coalesce(sum(commission_amount_cents), 0)
        from public.referral_commissions
        where status in ('pending', 'approved')
      ),
      'paidCommissionCents', (
        select coalesce(sum(commission_amount_cents), 0)
        from public.referral_commissions
        where status = 'paid'
      )
    ),
    'codes', (
      select coalesce(jsonb_agg(row_to_json(rows) order by rows.created_at desc), '[]'::jsonb)
      from (
        select
          c.id,
          c.code,
          c.referrer_name,
          c.referrer_email,
          c.commission_percent,
          c.payout_months,
          c.status,
          c.notes,
          c.created_at,
          count(distinct a.id)::int as attributed_garages,
          coalesce(sum(cm.invoice_amount_cents), 0)::int as revenue_cents,
          coalesce(sum(cm.commission_amount_cents) filter (where cm.status in ('pending', 'approved')), 0)::int as pending_commission_cents,
          coalesce(sum(cm.commission_amount_cents) filter (where cm.status = 'paid'), 0)::int as paid_commission_cents
        from public.referral_codes c
        left join public.referral_attributions a on a.referral_code_id = c.id
        left join public.referral_commissions cm on cm.referral_code_id = c.id
        group by c.id
        order by c.created_at desc
      ) rows
    ),
    'recentCommissions', (
      select coalesce(jsonb_agg(row_to_json(rows) order by rows.created_at desc), '[]'::jsonb)
      from (
        select
          cm.id,
          c.code,
          c.referrer_name,
          coalesce(g.name, p.email, 'Unknown customer') as customer,
          cm.invoice_amount_cents,
          cm.currency,
          cm.commission_percent,
          cm.commission_amount_cents,
          cm.payout_month_index,
          cm.status,
          cm.invoice_created_at,
          cm.created_at,
          cm.paid_at,
          cm.notes
        from public.referral_commissions cm
        join public.referral_codes c on c.id = cm.referral_code_id
        left join public.garages g on g.id = cm.garage_id
        left join public.profiles p on p.id = cm.user_id
        order by cm.created_at desc
        limit 50
      ) rows
    )
  )
  into v_stats;

  return v_stats;
end;
$$;

create or replace function public.create_referral_code(
  p_code text,
  p_referrer_name text,
  p_referrer_email text default null,
  p_commission_percent numeric default 20,
  p_payout_months int default 3,
  p_status text default 'active',
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := public.normalize_referral_code(p_code);
  v_row public.referral_codes;
begin
  perform public.ensure_admin_referral_access();

  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{2,31}$' then
    raise exception 'invalid_referral_code' using errcode = '22023';
  end if;

  insert into public.referral_codes (
    code,
    referrer_name,
    referrer_email,
    commission_percent,
    payout_months,
    status,
    notes,
    created_by
  )
  values (
    v_code,
    nullif(trim(coalesce(p_referrer_name, '')), ''),
    nullif(trim(coalesce(p_referrer_email, '')), ''),
    least(100, greatest(0, coalesce(p_commission_percent, 20))),
    least(36, greatest(1, coalesce(p_payout_months, 3))),
    case when p_status = 'paused' then 'paused' else 'active' end,
    nullif(trim(coalesce(p_notes, '')), ''),
    (select auth.uid())
  )
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

create or replace function public.update_referral_code(
  p_id uuid,
  p_referrer_name text,
  p_referrer_email text default null,
  p_commission_percent numeric default 20,
  p_payout_months int default 3,
  p_status text default 'active',
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.referral_codes;
begin
  perform public.ensure_admin_referral_access();

  update public.referral_codes
  set
    referrer_name = nullif(trim(coalesce(p_referrer_name, '')), ''),
    referrer_email = nullif(trim(coalesce(p_referrer_email, '')), ''),
    commission_percent = least(100, greatest(0, coalesce(p_commission_percent, 20))),
    payout_months = least(36, greatest(1, coalesce(p_payout_months, 3))),
    status = case when p_status = 'paused' then 'paused' else 'active' end,
    notes = nullif(trim(coalesce(p_notes, '')), '')
  where id = p_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'referral_code_not_found' using errcode = 'P0002';
  end if;

  return to_jsonb(v_row);
end;
$$;

create or replace function public.mark_referral_commission_paid(
  p_commission_id uuid,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.referral_commissions;
begin
  perform public.ensure_admin_referral_access();

  update public.referral_commissions
  set
    status = 'paid',
    paid_at = timezone('utc', now()),
    paid_by = (select auth.uid()),
    notes = nullif(trim(coalesce(p_notes, notes, '')), '')
  where id = p_commission_id
    and status <> 'void'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'referral_commission_not_found' using errcode = 'P0002';
  end if;

  return to_jsonb(v_row);
end;
$$;

alter table public.referral_codes enable row level security;
alter table public.referral_attributions enable row level security;
alter table public.referral_commissions enable row level security;

drop policy if exists "referral_codes_admin_all" on public.referral_codes;
create policy "referral_codes_admin_all"
on public.referral_codes
for all
to authenticated
using (public.is_admin_profile())
with check (public.is_admin_profile());

drop policy if exists "referral_attributions_admin_select" on public.referral_attributions;
create policy "referral_attributions_admin_select"
on public.referral_attributions
for select
to authenticated
using (public.is_admin_profile());

drop policy if exists "referral_commissions_admin_select" on public.referral_commissions;
create policy "referral_commissions_admin_select"
on public.referral_commissions
for select
to authenticated
using (public.is_admin_profile());

drop policy if exists "referral_commissions_admin_update" on public.referral_commissions;
create policy "referral_commissions_admin_update"
on public.referral_commissions
for update
to authenticated
using (public.is_admin_profile())
with check (public.is_admin_profile());

revoke all on public.referral_codes from public, anon, authenticated;
revoke all on public.referral_attributions from public, anon, authenticated;
revoke all on public.referral_commissions from public, anon, authenticated;

grant select, insert, update on public.referral_codes to authenticated;
grant select on public.referral_attributions to authenticated;
grant select, update on public.referral_commissions to authenticated;

grant all on public.referral_codes to service_role;
grant all on public.referral_attributions to service_role;
grant all on public.referral_commissions to service_role;

revoke all on function public.normalize_referral_code(text) from public;
revoke all on function public.ensure_admin_referral_access() from public;
revoke all on function public.get_admin_referrals() from public;
revoke all on function public.create_referral_code(text, text, text, numeric, int, text, text) from public;
revoke all on function public.update_referral_code(uuid, text, text, numeric, int, text, text) from public;
revoke all on function public.mark_referral_commission_paid(uuid, text) from public;

grant execute on function public.normalize_referral_code(text) to authenticated, service_role;
grant execute on function public.ensure_admin_referral_access() to authenticated, service_role;
grant execute on function public.get_admin_referrals() to authenticated, service_role;
grant execute on function public.create_referral_code(text, text, text, numeric, int, text, text) to authenticated, service_role;
grant execute on function public.update_referral_code(uuid, text, text, numeric, int, text, text) to authenticated, service_role;
grant execute on function public.mark_referral_commission_paid(uuid, text) to authenticated, service_role;
