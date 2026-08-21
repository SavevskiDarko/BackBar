-- ===========================================================================
-- BACKBAR — part 13: paying part of a table
--
-- Four people at a table, one leaves early and pays for what they had. They
-- get a receipt; the table stays open for the rest.
--
-- This needs a model change. Until now a bill borrowed its lines from the
-- order, which works only while there is exactly one bill per order. Once a
-- table can be paid in parts, the order keeps changing underneath — so a bill
-- has to own a snapshot of what was on it, or the first guest's receipt stops
-- describing what they actually paid for.
--
-- Run AFTER the previous twelve.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. A bill's own lines
-- ---------------------------------------------------------------------------

create table if not exists bill_lines (
  id         uuid primary key default gen_random_uuid(),
  bill_id    uuid not null references bills(id) on delete cascade,
  article_id uuid references articles(id) on delete set null,
  name       text not null,
  category   text,
  qty        int not null check (qty > 0),
  unit_price numeric(10,2) not null,
  unit_cost  numeric(10,2) not null,
  vat_rate   numeric(4,1) not null default 18.0
);
create index if not exists bill_lines_bill on bill_lines(bill_id);

alter table bill_lines enable row level security;

drop policy if exists bill_lines_staff_insert on bill_lines;
create policy bill_lines_staff_insert on bill_lines
  for insert with check (exists (
    select 1 from bills b where b.id = bill_id and is_staff_of(b.bar_id)
  ));

-- Only owners read them: they carry unit_cost, which waiters must not see.
drop policy if exists bill_lines_owner_read on bill_lines;
create policy bill_lines_owner_read on bill_lines
  for select using (exists (
    select 1 from bills b where b.id = bill_id and (is_owner_of(b.bar_id) or is_platform())
  ));

-- Existing bills: copy their order's lines across so history keeps working.
insert into bill_lines (bill_id, article_id, name, category, qty, unit_price, unit_cost, vat_rate)
select b.id, l.article_id, l.name, l.category, l.qty, l.unit_price, l.unit_cost, l.vat_rate
from bills b
join order_lines l on l.order_id = b.order_id
where not exists (select 1 from bill_lines bl where bl.bill_id = b.id);

-- A table can now produce several bills, so this can no longer be unique.
-- Replay safety moves entirely onto the client-generated bill id.
drop index if exists bills_one_per_order;

-- ---------------------------------------------------------------------------
-- 2. VAT from a bill's own lines
-- ---------------------------------------------------------------------------

create or replace function bill_vat_breakdown(p_bill uuid, p_discount numeric default 0)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.rate desc), '[]'::jsonb)
  from (
    select l.vat_rate as rate,
           round(sum(l.unit_price * l.qty) * (1 - coalesce(p_discount,0)/100), 2) as gross,
           round(sum(l.unit_price * l.qty) * (1 - coalesce(p_discount,0)/100)
                 / (1 + l.vat_rate/100), 2) as net,
           round(sum(l.unit_price * l.qty) * (1 - coalesce(p_discount,0)/100)
                 - sum(l.unit_price * l.qty) * (1 - coalesce(p_discount,0)/100)
                   / (1 + l.vat_rate/100), 2) as vat
    from bill_lines l
    where l.bill_id = p_bill
    group by l.vat_rate
  ) x
$$;

-- ---------------------------------------------------------------------------
-- 3. Paying part of a table
--
-- p_lines is what this guest is settling: [{ "article_id": "...", "qty": 2 }]
-- Anything not listed stays on the table.
-- ---------------------------------------------------------------------------

create or replace function pay_part_of_order(
  p_order    uuid,
  p_bill     uuid,                      -- client-generated: the idempotency key
  p_lines    jsonb,
  p_method   text,
  p_paid     boolean default true,
  p_discount numeric default 0,
  p_payments jsonb default null,
  p_customer jsonb default null
) returns bills
language plpgsql security definer set search_path = public, extensions as $$
declare
  o orders%rowtype; b bars%rowtype; v_bill bills%rowtype;
  v_line jsonb; v_src order_lines%rowtype; v_take int;
  v_disc numeric(5,2); v_gross numeric(10,2); v_cost numeric(10,2);
  v_total numeric(10,2); v_sum numeric(10,2); v_method text; v_left int;
begin
  -- A retry must return the bill already made, not make a second one.
  select * into v_bill from bills where id = p_bill;
  if found then return v_bill; end if;

  select * into o from orders where id = p_order;
  if not found then raise exception 'unknown_order'; end if;
  if not is_staff_of(o.bar_id) then raise exception 'not_your_bar'; end if;
  if not bar_is_live(o.bar_id) then raise exception 'subscription_inactive'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'nothing_selected'; end if;

  select * into b from bars where id = o.bar_id;

  v_disc := coalesce(p_discount, 0);
  if v_disc < 0 or v_disc > 100 then raise exception 'bad_discount'; end if;
  if jwt_staff_role() <> 'owner' and not b.allow_staff_discount then v_disc := 0; end if;

  insert into bills (id, bar_id, order_id, table_label, method, paid, settled_at,
                     discount, total, cost, staff_id, staff_name,
                     fiscal_status, customer_tax_id, customer_name)
  values (p_bill, o.bar_id, o.id, o.table_label, null, false, null,
          v_disc, 0, 0, o.staff_id, o.staff_name, 'not_required',
          nullif(p_customer->>'taxId', ''), nullif(p_customer->>'name', ''))
  returning * into v_bill;

  -- Move the chosen quantities off the table and onto this bill.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_src from order_lines
     where order_id = p_order and article_id = (v_line->>'article_id')::uuid;

    if not found then raise exception 'line_not_on_this_table'; end if;

    v_take := greatest(1, (v_line->>'qty')::int);
    if v_take > v_src.qty then raise exception 'more_than_is_on_the_table'; end if;

    insert into bill_lines (bill_id, article_id, name, category, qty,
                            unit_price, unit_cost, vat_rate)
    values (p_bill, v_src.article_id, v_src.name, v_src.category, v_take,
            v_src.unit_price, v_src.unit_cost, v_src.vat_rate);

    if v_take = v_src.qty then
      delete from order_lines where id = v_src.id;
    else
      update order_lines set qty = qty - v_take where id = v_src.id;
    end if;
  end loop;

  select coalesce(sum(unit_price * qty), 0), coalesce(sum(unit_cost * qty), 0)
    into v_gross, v_cost from bill_lines where bill_id = p_bill;

  v_total := round(v_gross * (1 - v_disc / 100), 2);

  if p_paid then
    if p_payments is not null and jsonb_array_length(p_payments) > 0 then
      if exists (select 1 from jsonb_array_elements(p_payments) e
                 where e->>'method' not in ('cash','card')) then
        raise exception 'bad_method';
      end if;
      select round(sum((e->>'amount')::numeric), 2) into v_sum
        from jsonb_array_elements(p_payments) e;
      if abs(v_sum - v_total) > 0.01 then raise exception 'payments_do_not_match_total'; end if;
      select e->>'method' into v_method from jsonb_array_elements(p_payments) e
       order by (e->>'amount')::numeric desc limit 1;
    else
      if p_method not in ('cash','card') then raise exception 'bad_method'; end if;
      v_method := p_method;
    end if;
  end if;

  update bills
     set total = v_total, cost = v_cost,
         method = v_method, paid = p_paid,
         settled_at = case when p_paid then now() end,
         payments = case when p_paid then p_payments end,
         vat_breakdown = bill_vat_breakdown(p_bill, v_disc),
         fiscal_status = case when b.fiscal_enabled and p_paid then 'pending' else 'not_required' end
   where id = p_bill
  returning * into v_bill;

  -- Nothing left on the table means the party is done.
  select count(*) into v_left from order_lines where order_id = p_order;
  if v_left = 0 then
    update orders set status = 'closed', closed_at = now() where id = p_order;
  end if;

  return v_bill;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Closing the whole table now snapshots its lines too
-- ---------------------------------------------------------------------------

create or replace function close_order_and_bill(
  p_order    uuid,
  p_method   text,
  p_paid     boolean,
  p_discount numeric default 0,
  p_bill     uuid default null,
  p_payments jsonb default null,
  p_customer jsonb default null
) returns bills
language plpgsql security definer set search_path = public, extensions as $$
declare
  o orders%rowtype; b bars%rowtype;
  v_gross numeric(10,2); v_cost numeric(10,2);
  v_disc numeric(5,2); v_total numeric(10,2);
  v_bill bills%rowtype; v_fiscal text;
  v_sum numeric(10,2); v_method text; v_id uuid;
begin
  v_id := coalesce(p_bill, gen_random_uuid());

  select * into v_bill from bills where id = v_id;
  if found then return v_bill; end if;      -- idempotent replay, by bill id

  select * into o from orders where id = p_order;
  if not found then raise exception 'unknown_order'; end if;
  if not is_staff_of(o.bar_id) then raise exception 'not_your_bar'; end if;
  if not bar_is_live(o.bar_id) then raise exception 'subscription_inactive'; end if;
  if o.status = 'closed' then
    select * into v_bill from bills where order_id = p_order order by closed_at desc limit 1;
    if found then return v_bill; end if;
    raise exception 'order_already_closed';
  end if;

  select * into b from bars where id = o.bar_id;

  v_disc := coalesce(p_discount, 0);
  if v_disc < 0 or v_disc > 100 then raise exception 'bad_discount'; end if;
  if jwt_staff_role() <> 'owner' and not b.allow_staff_discount then v_disc := 0; end if;

  insert into bills (id, bar_id, order_id, table_label, method, paid, settled_at,
                     discount, total, cost, staff_id, staff_name,
                     fiscal_status, customer_tax_id, customer_name)
  values (v_id, o.bar_id, o.id, o.table_label, null, false, null,
          v_disc, 0, 0, o.staff_id, o.staff_name, 'not_required',
          nullif(p_customer->>'taxId', ''), nullif(p_customer->>'name', ''))
  returning * into v_bill;

  -- The snapshot: what this bill covered, frozen at this moment.
  insert into bill_lines (bill_id, article_id, name, category, qty, unit_price, unit_cost, vat_rate)
  select v_id, l.article_id, l.name, l.category, l.qty, l.unit_price, l.unit_cost, l.vat_rate
  from order_lines l where l.order_id = p_order;

  select coalesce(sum(unit_price * qty), 0), coalesce(sum(unit_cost * qty), 0)
    into v_gross, v_cost from bill_lines where bill_id = v_id;

  v_total := round(v_gross * (1 - v_disc / 100), 2);

  if p_paid then
    if p_payments is not null and jsonb_array_length(p_payments) > 0 then
      if exists (select 1 from jsonb_array_elements(p_payments) e
                 where e->>'method' not in ('cash','card')) then raise exception 'bad_method'; end if;
      select round(sum((e->>'amount')::numeric), 2) into v_sum
        from jsonb_array_elements(p_payments) e;
      if abs(v_sum - v_total) > 0.01 then raise exception 'payments_do_not_match_total'; end if;
      select e->>'method' into v_method from jsonb_array_elements(p_payments) e
       order by (e->>'amount')::numeric desc limit 1;
    else
      if p_method not in ('cash','card') then raise exception 'bad_method'; end if;
      v_method := p_method;
    end if;
  end if;

  v_fiscal := case when b.fiscal_enabled and p_paid then 'pending' else 'not_required' end;

  update bills
     set total = v_total, cost = v_cost, method = v_method, paid = p_paid,
         settled_at = case when p_paid then now() end,
         payments = case when p_paid then p_payments end,
         vat_breakdown = bill_vat_breakdown(v_id, v_disc),
         fiscal_status = v_fiscal
   where id = v_id
  returning * into v_bill;

  update orders set status = 'closed', closed_at = now() where id = p_order;
  return v_bill;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Everything that read a bill's lines through the order now reads its own
-- ---------------------------------------------------------------------------

create or replace function fiscal_payload(p_bill uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_bill bills%rowtype; b bars%rowtype;
begin
  select * into v_bill from bills where id = p_bill;
  if not found then raise exception 'unknown_bill'; end if;
  if not is_staff_of(v_bill.bar_id) then raise exception 'not_your_bar'; end if;

  select * into b from bars where id = v_bill.bar_id;

  return jsonb_build_object(
    'billId', v_bill.id,
    'bar', jsonb_build_object('name', coalesce(b.legal_name, b.name),
                              'taxId', b.tax_id, 'device', b.fiscal_device,
                              'currency', b.currency),
    'table', v_bill.table_label,
    'staff', v_bill.staff_name,
    'closedAt', v_bill.settled_at,
    'method', v_bill.method,
    'payments', coalesce(v_bill.payments,
      jsonb_build_array(jsonb_build_object('method', v_bill.method, 'amount', v_bill.total))),
    'customer', case when v_bill.customer_tax_id is not null
      then jsonb_build_object('taxId', v_bill.customer_tax_id, 'name', v_bill.customer_name) end,
    'discount', v_bill.discount,
    'total', v_bill.total,
    'vat', v_bill.vat_breakdown,
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', l.name, 'qty', l.qty,
        'unitPrice', l.unit_price, 'vatRate', l.vat_rate,
        'lineTotal', round(l.unit_price * l.qty * (1 - v_bill.discount/100), 2)
      )), '[]'::jsonb)
      from bill_lines l where l.bill_id = v_bill.id
    )
  );
end $$;

create or replace function bar_products_sold(
  p_bar uuid, p_from date, p_to date
) returns table (
  name text, category text, qty bigint,
  gross numeric, cost numeric, profit numeric,
  margin numeric, share numeric, vat_rate numeric
) language plpgsql security definer set search_path = public as $$
declare v_cutoff int; v_total numeric;
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;
  select coalesce(day_cutoff_hour, 5) into v_cutoff from bars where id = p_bar;

  create temp table _sold on commit drop as
  select l.name, coalesce(l.category, 'Other') as category,
         sum(l.qty)::bigint as qty,
         round(sum(l.unit_price * l.qty * (1 - b.discount / 100)), 2) as gross,
         round(sum(l.unit_cost  * l.qty), 2) as cost,
         max(l.vat_rate) as vat_rate
  from bills b
  join bill_lines l on l.bill_id = b.id
  where b.bar_id = p_bar and b.paid and b.fiscal_status <> 'voided'
    and business_day(b.settled_at, v_cutoff) between p_from and p_to
  group by 1, 2;

  select coalesce(sum(s.gross), 0) into v_total from _sold s;

  return query
  select s.name, s.category, s.qty, s.gross, s.cost,
         round(s.gross - s.cost, 2),
         case when s.gross > 0 then round((s.gross - s.cost) / s.gross * 100, 1) else 0 end,
         case when v_total > 0 then round(s.gross / v_total * 100, 1) else 0 end,
         s.vat_rate
  from _sold s
  order by s.gross desc;
end $$;

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
  join bill_lines l on l.bill_id = b.id
  where b.bar_id = p_bar and b.paid and b.fiscal_status <> 'voided'
    and business_day(b.settled_at, v_cutoff) between p_from and p_to
  order by b.settled_at, l.name;
end $$;

-- bar_report joined order_lines for its category and top-item breakdowns, which
-- would now miss anything paid in parts.
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
    select b.*, business_day(b.settled_at, v_cutoff) as bday
    from bills b
    where b.bar_id = p_bar and b.paid
      and b.fiscal_status <> 'voided' and b.settled_at is not null
  ),
  cur  as (select * from scoped where bday between p_from and p_to),
  prev as (select * from scoped where bday between v_prev_from and v_prev_to),
  cur_lines as (
    select l.*, c.bday, c.discount from cur c join bill_lines l on l.bill_id = c.id
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'bucket', p_bucket, 'cutoffHour', v_cutoff,
    'totals', (select jsonb_build_object(
        'bills', count(*), 'gross', coalesce(sum(total), 0),
        'cost', coalesce(sum(cost), 0), 'profit', coalesce(sum(total - cost), 0),
        'cash', coalesce(sum(total) filter (where method = 'cash'), 0),
        'card', coalesce(sum(total) filter (where method = 'card'), 0),
        'avg',  coalesce(round(avg(total), 2), 0)) from cur),
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

notify pgrst, 'reload schema';
