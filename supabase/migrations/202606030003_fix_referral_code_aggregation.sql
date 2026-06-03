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
          (
            select count(*)::int
            from public.referral_attributions a
            where a.referral_code_id = c.id
          ) as attributed_garages,
          (
            select coalesce(sum(cm.invoice_amount_cents), 0)::int
            from public.referral_commissions cm
            where cm.referral_code_id = c.id
          ) as revenue_cents,
          (
            select coalesce(sum(cm.commission_amount_cents), 0)::int
            from public.referral_commissions cm
            where cm.referral_code_id = c.id
              and cm.status in ('pending', 'approved')
          ) as pending_commission_cents,
          (
            select coalesce(sum(cm.commission_amount_cents), 0)::int
            from public.referral_commissions cm
            where cm.referral_code_id = c.id
              and cm.status = 'paid'
          ) as paid_commission_cents
        from public.referral_codes c
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

revoke all on function public.get_admin_referrals() from public;
grant execute on function public.get_admin_referrals() to authenticated, service_role;
