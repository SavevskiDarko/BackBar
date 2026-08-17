-- ===========================================================================
-- BACKBAR — part 4: fiscal readiness
-- Run AFTER schema.sql, rpc.sql and offline.sql.
--
-- This does NOT make the app a legal fiscal device. In North Macedonia the POS
-- software itself is an "интегриран автоматски систем за управување" and needs
-- a UJP licence, and the receipt must come off an approved fiscal printer.
--
-- What this does is build the seam: every number a fiscal receipt needs is
-- captured, stamped at the moment of sale, and auditable — so integrating a
-- licensed printer later is wiring, not a migration of live bills.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- VAT per article
--
-- A bar carries three rates at once: 18% on alcohol, 10% on hospitality
-- (served food, coffee, soft drinks), 5% on packaged takeaway. The rate is a
-- property of the item, not the category, because "Cake" eaten in and the same
-- cake boxed to go are taxed differently.
--
-- Confirm the classification of your own menu with your accountant. Getting an
-- item into the wrong group is a tax error, not a display bug.
-- ---------------------------------------------------------------------------

alter table articles
  add column if not exists vat_rate numeric(4,1) not null default 18.0;

alter table articles
  add constraint articles_vat_sane check (vat_rate >= 0 and vat_rate <= 100);

-- Rates change by government decision, so the rate that applied at the moment
-- of sale is stamped onto the line — never read back from the article later.
alter table order_lines
  add column if not exists vat_rate numeric(4,1) not null default 18.0;

create or replace function stamp_line_prices() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare a articles%rowtype; o orders%rowtype;
begin
  select * into o from orders where id = new.order_id;
  if not found then raise exception 'unknown_order'; end if;

  select * into a from articles where id = new.article_id and bar_id = o.bar_id;
  if not found then raise exception 'article_not_on_this_bars_list'; end if;

  new.name       := a.name;
  new.category   := a.category;
  new.unit_price := a.sell_price;   -- ignores the client entirely
  new.unit_cost  := a.cost_price;
  new.vat_rate   := a.vat_rate;     -- the rate as at this sale
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- What the bar needs on a fiscal receipt
-- ---------------------------------------------------------------------------

alter table bars
  add column if not exists fiscal_enabled boolean not null default false,
  add column if not exists legal_name  text,   -- as registered, for the receipt header
  add column if not exists tax_id      text,   -- ЕДБ
  add column if not exists fiscal_device text; -- serial of the approved printer

-- ---------------------------------------------------------------------------
-- Fiscal state of each bill
--
-- A bill exists the moment a waiter closes it. Whether it has been fiscalised
-- is a separate fact, because the printer may be busy, offline, or out of
-- paper — and an unfiscalised bill is a compliance problem someone must see.
-- ---------------------------------------------------------------------------

alter table bills
  add column if not exists fiscal_status text not null default 'not_required'
    check (fiscal_status in ('not_required','pending','sent','failed','voided')),
  add column if not exists fiscal_receipt_no text,
  add column if not exists fiscal_printed_at timestamptz,
  add column if not exists fiscal_device text,
  add column if not exists fiscal_error text,
  add column if not exists vat_breakdown jsonb;

create index if not exists bills_needing_fiscal on bills(bar_id, fiscal_status)
  where fiscal_status in ('pending','failed');

-- An append-only trail. A licensed system has to be able to show what was sent
-- and what came back, so nothing here is ever updated or deleted.
create table if not exists fiscal_log (
  id         bigserial primary key,
  bar_id     uuid not null references bars(id) on delete cascade,
  bill_id    uuid references bills(id) on delete set null,
  at         timestamptz not null default now(),
  event      text not null,      -- 'sent' | 'printed' | 'failed' | 'voided' | 'z_report'
  device     text,
  receipt_no text,
  detail     jsonb
);
create index if not exists fiscal_log_bar_at on fiscal_log(bar_id, at desc);

alter table fiscal_log enable row level security;

create policy fiscal_log_staff_insert on fiscal_log
  for insert with check (is_staff_of(bar_id) and bar_is_live(bar_id));
create policy fiscal_log_owner_read on fiscal_log
  for select using (is_owner_of(bar_id) or is_platform());

-- ---------------------------------------------------------------------------
-- VAT breakdown, computed from the stamped line rates
--
-- Prices on a Macedonian bar menu are gross, so VAT is extracted rather than
-- added: net = gross / (1 + rate/100).
-- ---------------------------------------------------------------------------

create or replace function order_vat_breakdown(p_order uuid, p_discount numeric default 0)
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
    from order_lines l
    where l.order_id = p_order
    group by l.vat_rate
  ) x
$$;

-- ---------------------------------------------------------------------------
-- Closing a bill now also records the VAT split and whether it needs a receipt
-- ---------------------------------------------------------------------------

drop function if exists close_order_and_bill(uuid, text, boolean, numeric, uuid);

create or replace function close_order_and_bill(
  p_order    uuid,
  p_method   text,
  p_paid     boolean,
  p_discount numeric default 0,
  p_bill     uuid default null
) returns bills
language plpgsql security definer set search_path = public, extensions as $$
declare
  o orders%rowtype; b bars%rowtype;
  v_gross numeric(10,2); v_cost numeric(10,2);
  v_disc numeric(5,2); v_total numeric(10,2);
  v_bill bills%rowtype; v_fiscal text;
begin
  select * into o from orders where id = p_order;
  if not found then raise exception 'unknown_order'; end if;
  if not is_staff_of(o.bar_id) then raise exception 'not_your_bar'; end if;
  if not bar_is_live(o.bar_id) then raise exception 'subscription_inactive'; end if;

  select * into v_bill from bills where order_id = p_order limit 1;
  if found then return v_bill; end if;   -- idempotent replay

  if p_paid and p_method not in ('cash','card') then raise exception 'bad_method'; end if;

  select * into b from bars where id = o.bar_id;

  v_disc := coalesce(p_discount, 0);
  if v_disc < 0 or v_disc > 100 then raise exception 'bad_discount'; end if;
  if jwt_staff_role() <> 'owner' and not b.allow_staff_discount then v_disc := 0; end if;

  select coalesce(sum(unit_price * qty), 0), coalesce(sum(unit_cost * qty), 0)
    into v_gross, v_cost from order_lines where order_id = p_order;

  v_total := round(v_gross * (1 - v_disc / 100), 2);

  -- Only a paid bill needs a fiscal receipt. Something left on the tab is not
  -- a cash payment yet, so it becomes pending when it is actually settled.
  v_fiscal := case when b.fiscal_enabled and p_paid then 'pending' else 'not_required' end;

  insert into bills (id, bar_id, order_id, table_label, method, paid, settled_at,
                     discount, total, cost, staff_id, staff_name,
                     fiscal_status, vat_breakdown)
  values (coalesce(p_bill, gen_random_uuid()), o.bar_id, o.id, o.table_label,
          p_method, p_paid, case when p_paid then now() end,
          v_disc, v_total, v_cost, o.staff_id, o.staff_name,
          v_fiscal, order_vat_breakdown(p_order, v_disc))
  on conflict (id) do nothing
  returning * into v_bill;

  if v_bill.id is null then select * into v_bill from bills where id = p_bill; end if;

  update orders set status = 'closed', closed_at = now() where id = p_order;
  return v_bill;
end $$;

-- Settling an unpaid tab turns it into a cash payment, so now it needs a receipt.
create or replace function settle_bill(p_bill uuid, p_method text)
returns bills language plpgsql security definer set search_path = public as $$
declare v_bill bills%rowtype; v_fiscal boolean;
begin
  select * into v_bill from bills where id = p_bill;
  if not found then raise exception 'unknown_bill'; end if;
  if not is_owner_of(v_bill.bar_id) then raise exception 'owners_only'; end if;
  if p_method not in ('cash','card') then raise exception 'bad_method'; end if;

  select fiscal_enabled into v_fiscal from bars where id = v_bill.bar_id;

  update bills
     set paid = true, method = p_method, settled_at = now(),
         fiscal_status = case
           when fiscal_status = 'not_required' and v_fiscal then 'pending'
           else fiscal_status end
   where id = p_bill returning * into v_bill;
  return v_bill;
end $$;

-- ---------------------------------------------------------------------------
-- What the printer bridge calls back with
-- ---------------------------------------------------------------------------

create or replace function mark_bill_fiscalised(
  p_bill uuid, p_receipt_no text, p_device text, p_detail jsonb default null
) returns bills language plpgsql security definer set search_path = public as $$
declare v_bill bills%rowtype;
begin
  select * into v_bill from bills where id = p_bill;
  if not found then raise exception 'unknown_bill'; end if;
  if not is_staff_of(v_bill.bar_id) then raise exception 'not_your_bar'; end if;

  -- Idempotent: a retried callback must not overwrite a receipt number.
  if v_bill.fiscal_status = 'sent' then return v_bill; end if;

  update bills set fiscal_status = 'sent', fiscal_receipt_no = p_receipt_no,
                   fiscal_device = p_device, fiscal_printed_at = now(), fiscal_error = null
   where id = p_bill returning * into v_bill;

  insert into fiscal_log (bar_id, bill_id, event, device, receipt_no, detail)
  values (v_bill.bar_id, p_bill, 'printed', p_device, p_receipt_no, p_detail);

  return v_bill;
end $$;

create or replace function mark_bill_fiscal_failed(p_bill uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare v_bar uuid;
begin
  select bar_id into v_bar from bills where id = p_bill;
  if v_bar is null then raise exception 'unknown_bill'; end if;
  if not is_staff_of(v_bar) then raise exception 'not_your_bar'; end if;

  update bills set fiscal_status = 'failed', fiscal_error = left(p_error, 500)
   where id = p_bill and fiscal_status <> 'sent';

  insert into fiscal_log (bar_id, bill_id, event, detail)
  values (v_bar, p_bill, 'failed', jsonb_build_object('error', left(p_error, 500)));
end $$;

-- ---------------------------------------------------------------------------
-- Storno — a fiscal receipt is never deleted, it is reversed
-- ---------------------------------------------------------------------------

create or replace function void_bill(p_bill uuid, p_reason text)
returns bills language plpgsql security definer set search_path = public as $$
declare v_bill bills%rowtype;
begin
  select * into v_bill from bills where id = p_bill;
  if not found then raise exception 'unknown_bill'; end if;
  if not is_owner_of(v_bill.bar_id) then raise exception 'owners_only'; end if;
  if coalesce(p_reason, '') = '' then raise exception 'reason_required'; end if;

  update bills set fiscal_status = 'voided', fiscal_error = null,
                   paid = false, method = null
   where id = p_bill returning * into v_bill;

  insert into fiscal_log (bar_id, bill_id, event, receipt_no, detail)
  values (v_bill.bar_id, p_bill, 'voided', v_bill.fiscal_receipt_no,
          jsonb_build_object('reason', p_reason));

  return v_bill;
end $$;

-- ---------------------------------------------------------------------------
-- Daily report (Z) — the книга за дневни финансиски извештаи
-- ---------------------------------------------------------------------------

create table if not exists fiscal_day_reports (
  id            uuid primary key default gen_random_uuid(),
  bar_id        uuid not null references bars(id) on delete cascade,
  business_day  date not null,
  z_number      text,
  device        text,
  bills_count   int  not null default 0,
  total         numeric(12,2) not null default 0,
  cash          numeric(12,2) not null default 0,
  card          numeric(12,2) not null default 0,
  vat_breakdown jsonb,
  closed_at     timestamptz not null default now(),
  closed_by     uuid references staff(id) on delete set null,
  unique (bar_id, business_day)
);

alter table fiscal_day_reports enable row level security;
create policy day_reports_owner on fiscal_day_reports
  for all using (is_owner_of(bar_id) or is_platform())
  with check (is_owner_of(bar_id));

create or replace function close_business_day(
  p_bar uuid, p_day date default current_date,
  p_z_number text default null, p_device text default null
) returns fiscal_day_reports
language plpgsql security definer set search_path = public as $$
declare r fiscal_day_reports%rowtype;
begin
  if not is_owner_of(p_bar) then raise exception 'owners_only'; end if;

  insert into fiscal_day_reports (bar_id, business_day, z_number, device,
    bills_count, total, cash, card, vat_breakdown, closed_by)
  select p_bar, p_day, p_z_number, p_device,
    count(*),
    coalesce(sum(b.total), 0),
    coalesce(sum(b.total) filter (where b.method = 'cash'), 0),
    coalesce(sum(b.total) filter (where b.method = 'card'), 0),
    (select coalesce(jsonb_agg(jsonb_build_object('rate', rate, 'vat', vat, 'net', net)), '[]'::jsonb)
       from (
         select (e->>'rate')::numeric as rate,
                sum((e->>'vat')::numeric)  as vat,
                sum((e->>'net')::numeric)  as net
         from bills b2, jsonb_array_elements(coalesce(b2.vat_breakdown,'[]'::jsonb)) e
         where b2.bar_id = p_bar and b2.paid
           and b2.settled_at::date = p_day and b2.fiscal_status <> 'voided'
         group by 1
       ) g),
    nullif(jwt_staff_role(), '')::text::uuid
  from bills b
  where b.bar_id = p_bar and b.paid and b.settled_at::date = p_day
    and b.fiscal_status <> 'voided'
  on conflict (bar_id, business_day) do update
    set z_number = coalesce(excluded.z_number, fiscal_day_reports.z_number),
        device = coalesce(excluded.device, fiscal_day_reports.device),
        bills_count = excluded.bills_count, total = excluded.total,
        cash = excluded.cash, card = excluded.card,
        vat_breakdown = excluded.vat_breakdown, closed_at = now()
  returning * into r;

  insert into fiscal_log (bar_id, event, device, receipt_no, detail)
  values (p_bar, 'z_report', p_device, p_z_number,
          jsonb_build_object('day', p_day, 'total', r.total));

  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Everything the bridge needs to print one receipt, in one call
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

-- ---------------------------------------------------------------------------
-- Classify Fjaka's menu.
--
-- 18% alcohol · 10% hospitality (coffee, soft drinks, served sweets)
-- Have the accountant confirm this before it prints on a receipt.
-- ---------------------------------------------------------------------------

do $$
declare v_bar uuid;
begin
  select id into v_bar from bars where name = 'Fjaka';
  if v_bar is null then
    raise notice 'No bar named Fjaka — skipping VAT classification';
    return;
  end if;

  update articles set vat_rate = 18.0
   where bar_id = v_bar and category in ('Spirits','Cocktails','Beer','Wine');

  update articles set vat_rate = 10.0
   where bar_id = v_bar and category in ('Coffee','Not Coffee','Refreshments','Sweets');

  raise notice 'Fjaka VAT: % at 18%%, % at 10%%',
    (select count(*) from articles where bar_id = v_bar and vat_rate = 18),
    (select count(*) from articles where bar_id = v_bar and vat_rate = 10);
end $$;

-- ---------------------------------------------------------------------------
-- The snapshot must carry vat_rate, or the app can't show a tax split offline.
-- ---------------------------------------------------------------------------

create or replace function bar_snapshot(p_bar uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_owner boolean;
begin
  if not (is_staff_of(p_bar) or is_platform()) then raise exception 'not_your_bar'; end if;
  if not bar_is_live(p_bar) then raise exception 'subscription_inactive'; end if;
  v_owner := is_owner_of(p_bar) or is_platform();

  return jsonb_build_object(
    'bar', (select to_jsonb(b) - 'bar_code' from bars b where b.id = p_bar),
    'zones', (
      select coalesce(jsonb_agg(z order by z.sort), '[]'::jsonb) from (
        select z.id, z.name, z.sort,
          (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
             from tables t where t.zone_id = z.id) as tables
        from zones z where z.bar_id = p_bar
      ) z
    ),
    'articles', (
      select coalesce(jsonb_agg(a), '[]'::jsonb) from (
        select id, name, category, sell_price, vat_rate, active,
               case when v_owner then cost_price else null end as cost_price
        from articles where bar_id = p_bar and active
        order by category, name
      ) a
    ),
    'openOrders', (
      select coalesce(jsonb_agg(o), '[]'::jsonb) from (
        select o.id, o.table_id, o.table_label, o.guests, o.opened_at,
               o.staff_id, o.staff_name,
               (select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb)
                  from order_lines l where l.order_id = o.id) as lines
        from orders o where o.bar_id = p_bar and o.status = 'open'
        order by o.opened_at
      ) o
    ),
    'staff', (
      select coalesce(jsonb_agg(s), '[]'::jsonb) from (
        select id, name, role from staff
        where bar_id = p_bar and active and v_owner
      ) s
    )
  );
end $$;
