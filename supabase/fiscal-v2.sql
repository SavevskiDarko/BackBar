-- ===========================================================================
-- BACKBAR — part 11: what a Macedonian fiscal integrator actually needs
--
-- Five gaps identified by a fiscal operator reviewing the contract:
--   1. X-report — the mid-shift read that does not close the day
--   2. split payments — part cash, part card, on one bill
--   3. buyer tax number (ЕДБ) for a company receipt
--   4. cash drawer — opening it without printing anything
--   5. cash in / out — the shift float, which the law requires be recorded
--
-- Run AFTER the previous ten.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 2. Split payments
--
-- A 1000 den bill settled 500 cash and 500 card is ordinary, and a single
-- `method` column cannot describe it. The column stays for the common case and
-- for anything already written; `payments` carries the truth when it splits.
-- ---------------------------------------------------------------------------

alter table bills
  add column if not exists payments jsonb,          -- [{method, amount}, ...]
  add column if not exists customer_tax_id text,    -- ЕДБ of the buyer
  add column if not exists customer_name  text;

-- ---------------------------------------------------------------------------
-- 5. Cash movements
--
-- The opening float has to be registered on the device at the start of a
-- shift, and anything taken out during it recorded too. Without this the
-- drawer never reconciles against the fiscal device.
-- ---------------------------------------------------------------------------

create table if not exists cash_movements (
  id         uuid primary key default gen_random_uuid(),
  bar_id     uuid not null references bars(id) on delete cascade,
  at         timestamptz not null default now(),
  kind       text not null check (kind in ('in','out')),
  amount     numeric(10,2) not null check (amount > 0),
  reason     text,
  staff_id   uuid references staff(id) on delete set null,
  staff_name text,
  fiscal_ref text            -- what the device called it, once printed
);
create index if not exists cash_movements_bar_at on cash_movements(bar_id, at desc);

alter table cash_movements enable row level security;

create policy cash_staff_insert on cash_movements
  for insert with check (is_staff_of(bar_id) and bar_is_live(bar_id));
create policy cash_owner_read on cash_movements
  for select using (is_owner_of(bar_id) or is_platform());

create or replace function record_cash_movement(
  p_bar uuid, p_kind text, p_amount numeric, p_reason text default null,
  p_fiscal_ref text default null
) returns cash_movements
language plpgsql security definer set search_path = public as $$
declare v cash_movements%rowtype; v_name text;
begin
  if not is_staff_of(p_bar) then raise exception 'not_your_bar'; end if;
  if not bar_is_live(p_bar) then raise exception 'subscription_inactive'; end if;
  if p_kind not in ('in','out') then raise exception 'bad_kind'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'amount_must_be_positive'; end if;

  select name into v_name from staff
   where id = nullif(auth.jwt() ->> 'staff_id', '')::uuid;

  insert into cash_movements (bar_id, kind, amount, reason, staff_id, staff_name, fiscal_ref)
  values (p_bar, p_kind, round(p_amount, 2), p_reason,
          nullif(auth.jwt() ->> 'staff_id', '')::uuid, v_name, p_fiscal_ref)
  returning * into v;

  insert into fiscal_log (bar_id, event, receipt_no, detail)
  values (p_bar, 'cash_' || p_kind, p_fiscal_ref,
          jsonb_build_object('amount', p_amount, 'reason', p_reason));

  return v;
end $$;

-- What should physically be in the drawer right now.
create or replace function cash_in_drawer(p_bar uuid, p_day date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cutoff int; v_day date; v_cash numeric; v_in numeric; v_out numeric;
begin
  if not (is_staff_of(p_bar) or is_platform()) then raise exception 'not_your_bar'; end if;
  select coalesce(day_cutoff_hour, 5) into v_cutoff from bars where id = p_bar;
  v_day := coalesce(p_day, business_day(now(), v_cutoff));

  -- Cash taken across bills, counting only the cash part of a split.
  select coalesce(sum(
    case when b.payments is null
         then case when b.method = 'cash' then b.total else 0 end
         else coalesce((
           select sum((p->>'amount')::numeric)
           from jsonb_array_elements(b.payments) p
           where p->>'method' = 'cash'
         ), 0)
    end), 0)
  into v_cash
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

-- ---------------------------------------------------------------------------
-- Closing a bill, now with splits and a buyer
-- ---------------------------------------------------------------------------

drop function if exists close_order_and_bill(uuid, text, boolean, numeric, uuid);

create or replace function close_order_and_bill(
  p_order    uuid,
  p_method   text,
  p_paid     boolean,
  p_discount numeric default 0,
  p_bill     uuid default null,
  p_payments jsonb default null,      -- [{method, amount}, ...]
  p_customer jsonb default null       -- {taxId, name}
) returns bills
language plpgsql security definer set search_path = public, extensions as $$
declare
  o orders%rowtype; b bars%rowtype;
  v_gross numeric(10,2); v_cost numeric(10,2);
  v_disc numeric(5,2); v_total numeric(10,2);
  v_bill bills%rowtype; v_fiscal text;
  v_sum numeric(10,2); v_method text;
begin
  select * into o from orders where id = p_order;
  if not found then raise exception 'unknown_order'; end if;
  if not is_staff_of(o.bar_id) then raise exception 'not_your_bar'; end if;
  if not bar_is_live(o.bar_id) then raise exception 'subscription_inactive'; end if;

  select * into v_bill from bills where order_id = p_order limit 1;
  if found then return v_bill; end if;   -- idempotent replay

  select * into b from bars where id = o.bar_id;

  v_disc := coalesce(p_discount, 0);
  if v_disc < 0 or v_disc > 100 then raise exception 'bad_discount'; end if;
  if jwt_staff_role() <> 'owner' and not b.allow_staff_discount then v_disc := 0; end if;

  select coalesce(sum(unit_price * qty), 0), coalesce(sum(unit_cost * qty), 0)
    into v_gross, v_cost from order_lines where order_id = p_order;

  v_total := round(v_gross * (1 - v_disc / 100), 2);

  if p_paid then
    if p_payments is not null and jsonb_array_length(p_payments) > 0 then
      -- Every part must name a real method, and the parts must add up. A split
      -- that does not reconcile is a drawer that will not reconcile either.
      if exists (
        select 1 from jsonb_array_elements(p_payments) e
        where e->>'method' not in ('cash','card')
      ) then raise exception 'bad_method'; end if;

      select round(sum((e->>'amount')::numeric), 2) into v_sum
      from jsonb_array_elements(p_payments) e;

      if abs(v_sum - v_total) > 0.01 then raise exception 'payments_do_not_match_total'; end if;

      -- The single column keeps the dominant method, for old reports and for
      -- anything that only understands one.
      select e->>'method' into v_method
      from jsonb_array_elements(p_payments) e
      order by (e->>'amount')::numeric desc limit 1;
    else
      if p_method not in ('cash','card') then raise exception 'bad_method'; end if;
      v_method := p_method;
    end if;
  end if;

  v_fiscal := case when b.fiscal_enabled and p_paid then 'pending' else 'not_required' end;

  insert into bills (id, bar_id, order_id, table_label, method, paid, settled_at,
                     discount, total, cost, staff_id, staff_name,
                     fiscal_status, vat_breakdown, payments,
                     customer_tax_id, customer_name)
  values (coalesce(p_bill, gen_random_uuid()), o.bar_id, o.id, o.table_label,
          v_method, p_paid, case when p_paid then now() end,
          v_disc, v_total, v_cost, o.staff_id, o.staff_name,
          v_fiscal, order_vat_breakdown(p_order, v_disc),
          case when p_paid then p_payments end,
          nullif(p_customer->>'taxId', ''), nullif(p_customer->>'name', ''))
  on conflict (id) do nothing
  returning * into v_bill;

  if v_bill.id is null then select * into v_bill from bills where id = p_bill; end if;

  update orders set status = 'closed', closed_at = now() where id = p_order;
  return v_bill;
end $$;

-- ---------------------------------------------------------------------------
-- The payload the bridge receives — now carries the split and the buyer
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
    -- Always an array, even for a single tender, so the bridge has one shape
    -- to implement rather than two.
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
      from order_lines l where l.order_id = v_bill.order_id
    )
  );
end $$;
