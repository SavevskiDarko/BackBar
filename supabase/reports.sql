-- ===========================================================================
-- BACKBAR — part 5: owner reporting
-- Run AFTER schema.sql, rpc.sql, offline.sql and fiscal.sql.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The business day
--
-- A bar selling until 02:00 does not want Friday night's last two hours
-- counted as Saturday. Without this every busy weekend is split across two
-- dates and the owner's Friday looks quiet for no reason.
--
-- A "day" therefore runs cutoff-to-cutoff. 5am suits most bars; somewhere
-- closing at 6am would set 7.
-- ---------------------------------------------------------------------------

alter table bars
  add column if not exists day_cutoff_hour int not null default 5;

do $$ begin
  alter table bars add constraint bars_cutoff_sane
    check (day_cutoff_hour between 0 and 12);
exception when duplicate_object then null; end $$;

create or replace function business_day(p_at timestamptz, p_cutoff int)
returns date language sql immutable as $$
  select (p_at - make_interval(hours => p_cutoff))::date
$$;

-- ---------------------------------------------------------------------------
-- One call for a whole report.
--
-- A month of bills with their lines is thousands of rows. Sending that to a
-- phone to be summed in JavaScript is slow on bar wifi, so the database
-- aggregates and returns a few kilobytes.
-- ---------------------------------------------------------------------------

create or replace function bar_report(
  p_bar    uuid,
  p_from   date,
  p_to     date,                   -- inclusive
  p_bucket text default 'day'      -- 'hour' for a single day, else 'day'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_cutoff int; v_len int;
  v_prev_from date; v_prev_to date;
  v_out jsonb;
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;
  if not bar_is_live(p_bar) then raise exception 'subscription_inactive'; end if;

  select day_cutoff_hour into v_cutoff from bars where id = p_bar;
  v_cutoff := coalesce(v_cutoff, 5);

  -- The preceding period of equal length. "Up or down on last week" is the
  -- number an owner actually acts on.
  v_len := (p_to - p_from) + 1;
  v_prev_from := p_from - v_len;
  v_prev_to   := p_from - 1;

  with scoped as (
    select b.*, business_day(b.settled_at, v_cutoff) as bday
    from bills b
    where b.bar_id = p_bar and b.paid
      and b.fiscal_status <> 'voided' and b.settled_at is not null
  ),
  cur  as (select * from scoped where bday between p_from and p_to),
  prev as (select * from scoped where bday between v_prev_from and v_prev_to),
  cur_lines as (
    select l.*, c.bday, c.discount
    from cur c join order_lines l on l.order_id = c.order_id
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'bucket', p_bucket, 'cutoffHour', v_cutoff,

    'totals', (select jsonb_build_object(
        'bills',  count(*),
        'gross',  coalesce(sum(total), 0),
        'cost',   coalesce(sum(cost), 0),
        'profit', coalesce(sum(total - cost), 0),
        'cash',   coalesce(sum(total) filter (where method = 'cash'), 0),
        'card',   coalesce(sum(total) filter (where method = 'card'), 0),
        'avg',    coalesce(round(avg(total), 2), 0)
      ) from cur),

    'previous', (select jsonb_build_object(
        'bills',  count(*),
        'gross',  coalesce(sum(total), 0),
        'profit', coalesce(sum(total - cost), 0)
      ) from prev),

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

    -- Which nights are worth staffing.
    'byWeekday', (select coalesce(jsonb_agg(jsonb_build_object(
              'dow', dow, 'name', name, 'gross', g, 'days', days) order by dow), '[]'::jsonb)
      from (select extract(isodow from bday)::int as dow,
                   to_char(bday, 'Dy') as name,
                   round(sum(total), 2) as g,
                   count(distinct bday) as days
            from cur group by 1, 2) w),

    'byStaff', (select coalesce(jsonb_agg(jsonb_build_object(
              'name', staff_name, 'bills', n, 'gross', g) order by g desc), '[]'::jsonb)
      from (select staff_name, count(*) n, round(sum(total), 2) g
            from cur group by 1) s),

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
            from cur_lines group by 1, 2
            limit 25) t),

    -- Things needing attention regardless of the period on screen.
    'attention', jsonb_build_object(
      'unpaidBills',   (select count(*) from bills where bar_id = p_bar and not paid),
      'unpaidTotal',   (select coalesce(sum(total), 0) from bills where bar_id = p_bar and not paid),
      'noFiscal',      (select count(*) from bills where bar_id = p_bar and paid
                          and fiscal_status in ('pending','failed')),
      'zeroCostItems', (select count(*) from articles where bar_id = p_bar and active and cost_price = 0)
    )
  ) into v_out;

  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- Line-level export for the accountant. Deliberately not aggregated.
-- ---------------------------------------------------------------------------

create or replace function bar_report_rows(p_bar uuid, p_from date, p_to date)
returns table (
  day date, closed_at timestamptz, table_label text, staff text, method text,
  item text, category text, qty int, unit_price numeric, vat_rate numeric,
  line_total numeric, receipt_no text
) language plpgsql security definer set search_path = public as $$
declare v_cutoff int;
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;
  select coalesce(day_cutoff_hour, 5) into v_cutoff from bars where id = p_bar;

  return query
  select business_day(b.settled_at, v_cutoff), b.settled_at, b.table_label,
         b.staff_name, b.method, l.name, l.category, l.qty,
         l.unit_price, l.vat_rate,
         round(l.unit_price * l.qty * (1 - b.discount / 100), 2),
         b.fiscal_receipt_no
  from bills b
  join order_lines l on l.order_id = b.order_id
  where b.bar_id = p_bar and b.paid and b.fiscal_status <> 'voided'
    and business_day(b.settled_at, v_cutoff) between p_from and p_to
  order by b.settled_at, l.name;
end $$;

drop function if exists bar_daily_rows(uuid, date, date);
