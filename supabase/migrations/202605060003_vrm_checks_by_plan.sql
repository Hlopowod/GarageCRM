-- Align monthly VRM/vehicle check allowances with the pricing plan capacity.

update public.plan_limits
set
  max_vrm_checks_per_month = case plan
    when 'pit_stop' then 0
    when 'service_bay' then 100
    when 'full_workshop' then 200
    when 'garage_empire' then 500
    else max_vrm_checks_per_month
  end,
  can_check_vrm = case plan
    when 'pit_stop' then false
    when 'service_bay' then true
    when 'full_workshop' then true
    when 'garage_empire' then true
    else can_check_vrm
  end
where plan in ('pit_stop', 'service_bay', 'full_workshop', 'garage_empire');
