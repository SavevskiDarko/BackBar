-- ===========================================================================
-- FIX: cash under-reported when a bill is split between cash and card
--
-- bills.method holds only the dominant method, so a 1000 bill settled
-- 400 cash / 600 card was counted as 1000 card and 0 cash. The drawer was
-- right; the report was wrong. Introduced with split payments.
--
-- bills.payments has the truth whenever a bill was split. Read that.
-- ===========================================================================

-- The cash part of a bill, whether it was split or not. One definition, used
-- everywhere, so the report and the drawer can never disagree again.
create or replace function bill_cash_part(b bills)
returns numeric language sql immutable as $$
  select case
    when b.payments is null
      then case when b.method = 'cash' then b.total else 0 end
    else coalesce((
      select sum((p->>'amount')::numeric)
      from jsonb_array_elements(b.payments) p
      where p->>'method' = 'cash'), 0)
  end
$$;

create or replace function bill_card_part(b bills)
returns numeric language sql immutable as $$
  select case
    when b.payments is null
      then case when b.method = 'card' then b.total else 0 end
    else coalesce((
      select sum((p->>'amount')::numeric)
      from jsonb_array_elements(b.payments) p
      where p->>'method' = 'card'), 0)
  end
$$;

create or replace function bar_report(
  p_bar uuid, p_from date, p_to date, p_bucket text default 'day'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_cutoff int; v_len int; v_prev_from date; v_prev_to date; v_out jsonb;
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;
  if not bar_is_live(p_bar) then raise exception 'subscription_inactive'; end if;

  select coalesce(day_cutoff_hour, 5) into v_cutoff from bars where id = p_bar;
  v_len := (p_to - p_from) + 1;
  v_prev_from := p_from - v_len;
  v_prev_to   := p_from - 1;

  with scoped as (
    select b.*, business_day(b.settled_at, v_cutoff) as bday,
           bill_cash_part(b.*) as cash_part,
           bill_card_part(b.*) as card_part
    from bills b
    where b.bar_id = p_bar and b.paid
      and b.fiscal_status <> 'voided' and b.settled_at is not null
  ),
  cur  as (select * from scoped where bday between p_from and p_to),
  prev as (select * from scoped where bday between v_prev_from and v_prev_to),
  cur_lines as (
    select l.*, c.bday, c.discount from cur c join bill_lines l on l.bill_id = c.id
  ),
  moves as (
    select coalesce(sum(amount) filter (where kind = 'in'), 0) as paid_in,
           coalesce(sum(amount) filter (where kind = 'out'), 0) as paid_out
    from cash_movements
    where bar_id = p_bar and business_day(at, v_cutoff) between p_from and p_to
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'bucket', p_bucket, 'cutoffHour', v_cutoff,
    'totals', (select jsonb_build_object(
        'bills', count(*), 'gross', coalesce(sum(total), 0),
        'cost', coalesce(sum(cost), 0), 'profit', coalesce(sum(total - cost), 0),
        -- The actual split, not the dominant method.
        'cash', coalesce(sum(cash_part), 0),
        'card', coalesce(sum(card_part), 0),
        'avg',  coalesce(round(avg(total), 2), 0)) from cur),
    -- What should be in the drawer: cash taken, plus paid in, minus paid out.
    'drawer', (select jsonb_build_object(
        'cashSales', (select coalesce(sum(cash_part), 0) from cur),
        'paidIn', m.paid_in, 'paidOut', m.paid_out,
        'expected', round((select coalesce(sum(cash_part), 0) from cur) + m.paid_in - m.paid_out, 2))
      from moves m),
    'previous', (select jsonb_build_object(
        'bills', count(*), 'gross', coalesce(sum(total), 0),
        'profit', coalesce(sum(total - cost), 0)) from prev),
    'vat', (select coalesce(jsonb_agg(jsonb_build_object(
              'rate', rate, 'net', net, 'vat', vat) order by rate desc), '[]'::jsonb)
      from (select (e->>'rate')::numeric as rate,
                   round(sum((e->>'net')::numeric), 2) as net,
                   round(sum((e->>'vat')::numeric), 2) as vat
            from cur, jsonb_array_elements(coalesce(cur.vat_breakdown, '[]'::jsonb)) e
            group by 1) v),
    'series', (case when p_bucket = 'hour' then (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'label', lpad(h::text, 2, '0'), 'gross', g) order by h), '[]'::jsonb)
        from (select extract(hour from settled_at)::int as h, round(sum(total), 2) as g
              from cur group by 1) s
      ) else (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'label', to_char(d, 'DD Mon'), 'weekday', to_char(d, 'Dy'),
                 'gross', g) order by d), '[]'::jsonb)
        from (select bday as d, round(sum(total), 2) as g from cur group by 1) s
      ) end),
    'byWeekday', (select coalesce(jsonb_agg(jsonb_build_object(
              'dow', dow, 'name', name, 'gross', g, 'days', days) order by dow), '[]'::jsonb)
      from (select extract(isodow from bday)::int as dow, to_char(bday, 'Dy') as name,
                   round(sum(total), 2) as g, count(distinct bday) as days
            from cur group by 1, 2) w),
    'byStaff', (select coalesce(jsonb_agg(jsonb_build_object(
              'name', staff_name, 'bills', n, 'gross', g) order by g desc), '[]'::jsonb)
      from (select staff_name, count(*) n, round(sum(total), 2) g from cur group by 1) s),
    'byCategory', (select coalesce(jsonb_agg(jsonb_build_object(
              'category', category, 'gross', g) order by g desc), '[]'::jsonb)
      from (select coalesce(category, 'Other') as category,
                   round(sum(unit_price * qty * (1 - discount/100)), 2) as g
            from cur_lines group by 1) c),
    'topItems', (select coalesce(jsonb_agg(jsonb_build_object(
              'name', name, 'category', category, 'qty', q,
              'gross', g, 'cost', c, 'profit', g - c) order by (g - c) desc), '[]'::jsonb)
      from (select name, coalesce(category, 'Other') as category, sum(qty) q,
                   round(sum(unit_price * qty * (1 - discount/100)), 2) g,
                   round(sum(unit_cost * qty), 2) c
            from cur_lines group by 1, 2 limit 25) t),
    'attention', jsonb_build_object(
      'unpaidBills', (select count(*) from bills where bar_id = p_bar and not paid),
      'unpaidTotal', (select coalesce(sum(total), 0) from bills where bar_id = p_bar and not paid),
      'noFiscal',    (select count(*) from bills where bar_id = p_bar and paid
                        and fiscal_status in ('pending','failed')),
      'zeroCostItems', (select count(*) from articles where bar_id = p_bar and active and cost_price = 0))
  ) into v_out;

  return v_out;
end $$;

-- cash_in_drawer already read the split correctly, but let it share the one
-- definition so the two can never drift apart.
create or replace function cash_in_drawer(p_bar uuid, p_day date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cutoff int; v_day date; v_cash numeric; v_in numeric; v_out numeric;
begin
  if not (is_staff_of(p_bar) or is_platform()) then raise exception 'not_your_bar'; end if;
  select coalesce(day_cutoff_hour, 5) into v_cutoff from bars where id = p_bar;
  v_day := coalesce(p_day, business_day(now(), v_cutoff));

  select coalesce(sum(bill_cash_part(b.*)), 0) into v_cash
  from bills b
  where b.bar_id = p_bar and b.paid and b.fiscal_status <> 'voided'
    and business_day(b.settled_at, v_cutoff) = v_day;

  select coalesce(sum(amount) filter (where kind = 'in'), 0),
         coalesce(sum(amount) filter (where kind = 'out'), 0)
    into v_in, v_out
  from cash_movements
  where bar_id = p_bar and business_day(at, v_cutoff) = v_day;

  return jsonb_build_object(
    'day', v_day, 'cashSales', v_cash, 'paidIn', v_in, 'paidOut', v_out,
    'expected', round(v_cash + v_in - v_out, 2)
  );
end $$;

notify pgrst, 'reload schema';
