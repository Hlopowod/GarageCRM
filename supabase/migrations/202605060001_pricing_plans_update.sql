-- Update Garage CRM billing plans to the public pricing model:
-- Pit Stop, Service Bay, Full Workshop, Garage Empire.
--
-- Existing free/basic/ultimate rows are migrated to the closest new plan names.
-- Edge Functions should be deployed with the matching plan mapping after this runs.

do $$
declare
  item record;
begin
  for item in
    select
      n.nspname as schema_name,
      t.relname as table_name,
      c.conname as constraint_name
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname in ('garages', 'plan_limits')
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%plan%'
  loop
    execute format(
      'alter table %I.%I drop constraint if exists %I',
      item.schema_name,
      item.table_name,
      item.constraint_name
    );
  end loop;
end $$;

alter table public.plan_limits
  add column if not exists max_bookings_per_month int not null default 30,
  add column if not exists max_customer_records int not null default 30,
  add column if not exists max_job_cards_per_month int not null default 30;

delete from public.plan_limits
where plan in ('free', 'basic', 'ultimate');

alter table public.plan_limits
  add constraint plan_limits_plan_check
  check (plan in ('pit_stop', 'service_bay', 'full_workshop', 'garage_empire'));

update public.garages
set plan = case plan
  when 'free' then 'pit_stop'
  when 'basic' then 'service_bay'
  when 'ultimate' then 'garage_empire'
  else plan
end
where plan in ('free', 'basic', 'ultimate');

alter table public.garages
  alter column plan set default 'pit_stop';

alter table public.garages
  add constraint garages_plan_check
  check (plan in ('pit_stop', 'service_bay', 'full_workshop', 'garage_empire'));

insert into public.plan_limits (
  plan,
  max_vehicle_records_per_month,
  max_bookings_per_month,
  max_customer_records,
  max_job_cards_per_month,
  max_sms_per_month,
  max_vrm_checks_per_month,
  max_users,
  can_send_sms,
  can_check_vrm,
  can_use_automations
) values
  ('pit_stop', 30, 30, 30, 30, 0, 0, 1, false, false, false),
  ('service_bay', 100, 100, 100, 100, 100, 100, 1, true, true, true),
  ('full_workshop', 200, 200, 200, 200, 250, 200, 3, true, true, true),
  ('garage_empire', 2147483647, 2147483647, 2147483647, 2147483647, 500, 500, 5, true, true, true)
on conflict (plan) do update set
  max_vehicle_records_per_month = excluded.max_vehicle_records_per_month,
  max_bookings_per_month = excluded.max_bookings_per_month,
  max_customer_records = excluded.max_customer_records,
  max_job_cards_per_month = excluded.max_job_cards_per_month,
  max_sms_per_month = excluded.max_sms_per_month,
  max_vrm_checks_per_month = excluded.max_vrm_checks_per_month,
  max_users = excluded.max_users,
  can_send_sms = excluded.can_send_sms,
  can_check_vrm = excluded.can_check_vrm,
  can_use_automations = excluded.can_use_automations;
