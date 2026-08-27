-- ===========================================================================
-- BACKBAR — part 17: shifts, and moving tables
--
-- Two things a bar does every night that the app couldn't.
--
-- SHIFTS. The drawer figure is currently for the whole bar, so a shortfall has
-- nobody's name on it. A waiter opens a shift with a float, takes cash, and
-- declares what they hand over. The difference is recorded against them.
--
-- MOVING TABLES. Guests move; two tables push together. Both happen hourly.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Who actually took the money
--
-- bills.staff_id is whoever OPENED the table. For a cash-up what matters is who
-- CLOSED it — often a different person on a busy night, and the drawer follows
-- the second one.
-- ---------------------------------------------------------------------------

alter table bills
  add column if not exists settled_by_id   uuid references staff(id) on delete set null,
  add column if not exists settled_by_name text;

create or replace function stamp_settled_by() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.paid and new.settled_by_id is null then
    new.settled_by_id   := nullif(auth.jwt() ->> 'staff_id', '')::uuid;
    new.settled_by_name := coalesce(auth.jwt() ->> 'staff_name', new.staff_name);
  end if;
  return new;
end $$;

drop trigger if exists bills_stamp_settled_by on bills;
create trigger bills_stamp_settled_by
  before insert or update of paid on bills
  for each row execute function stamp_settled_by();

-- Anything already paid: the opener is the best guess we have.
update bills set settled_by_id = staff_id, settled_by_name = staff_name
where paid and settled_by_id is null;

-- ---------------------------------------------------------------------------
-- Shifts
-- ---------------------------------------------------------------------------

create table if not exists shifts (
  id            uuid primary key default gen_random_uuid(),
  bar_id        uuid not null references bars(id) on delete cascade,
  staff_id      uuid references staff(id) on delete set null,
  staff_name    text not null,
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  opening_float numeric(10,2) not null default 0,
  declared_cash numeric(10,2),          -- what they say they're handing over
  expected_cash numeric(10,2),          -- what the bills say it should be
  variance      numeric(10,2),          -- declared - expected
  note          text
);
create index if not exists shifts_bar on shifts(bar_id, opened_at desc);
create unique index if not exists shifts_one_open_per_staff
  on shifts(bar_id, staff_id) where closed_at is null;

alter table shifts enable row level security;

drop policy if exists shifts_staff on shifts;
create policy shifts_staff on shifts
  for all using (is_staff_of(bar_id)) with check (is_staff_of(bar_id));

/** Cash this person has taken since their shift opened. */
create or replace function shift_expected_cash(p_shift uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(bill_cash_part(b.*)), 0) + s.opening_float
  from shifts s
  left join bills b
    on b.bar_id = s.bar_id
   and b.paid and b.fiscal_status <> 'voided'
   and b.settled_by_id is not distinct from s.staff_id
   and b.settled_at >= s.opened_at
   and b.settled_at <= coalesce(s.closed_at, now())
  where s.id = p_shift
  group by s.opening_float
$$;

create or replace function open_shift(p_bar uuid, p_float numeric default 0)
returns shifts language plpgsql security definer set search_path = public as $$
declare v shifts%rowtype; v_id uuid; v_name text;
begin
  if not is_staff_of(p_bar) then raise exception 'not_your_bar'; end if;
  if not bar_is_live(p_bar) then raise exception 'subscription_inactive'; end if;

  v_id := nullif(auth.jwt() ->> 'staff_id', '')::uuid;
  select name into v_name from staff where id = v_id;

  select * into v from shifts
   where bar_id = p_bar and staff_id is not distinct from v_id and closed_at is null;
  if found then return v; end if;         -- already open; don't start a second

  insert into shifts (bar_id, staff_id, staff_name, opening_float)
  values (p_bar, v_id, coalesce(v_name, 'unknown'), coalesce(p_float, 0))
  returning * into v;

  -- A float put in the drawer is a cash movement like any other.
  if coalesce(p_float, 0) > 0 then
    insert into cash_movements (bar_id, kind, amount, reason, staff_id, staff_name)
    values (p_bar, 'in', p_float, 'shift float', v_id, v_name);
  end if;

  return v;
end $$;

/** Close it and record the difference. The variance is the point: it is what
    turns "the drawer is short" into "the drawer is short on someone's shift". */
create or replace function close_shift(p_shift uuid, p_declared numeric, p_note text default null)
returns shifts language plpgsql security definer set search_path = public as $$
declare v shifts%rowtype; v_expected numeric;
begin
  select * into v from shifts where id = p_shift;
  if not found then raise exception 'unknown_shift'; end if;
  if not is_staff_of(v.bar_id) then raise exception 'not_your_bar'; end if;
  if v.closed_at is not null then return v; end if;

  v_expected := coalesce(shift_expected_cash(p_shift), v.opening_float);

  update shifts
     set closed_at = now(),
         declared_cash = round(coalesce(p_declared, 0), 2),
         expected_cash = round(v_expected, 2),
         variance = round(coalesce(p_declared, 0) - v_expected, 2),
         note = p_note
   where id = p_shift
  returning * into v;

  return v;
end $$;

/** The shift this person has open, with what it's worth so far. */
create or replace function my_shift(p_bar uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v shifts%rowtype; v_id uuid;
begin
  if not is_staff_of(p_bar) then raise exception 'not_your_bar'; end if;
  v_id := nullif(auth.jwt() ->> 'staff_id', '')::uuid;

  select * into v from shifts
   where bar_id = p_bar and staff_id is not distinct from v_id and closed_at is null;
  if not found then return null; end if;

  return jsonb_build_object(
    'id', v.id, 'openedAt', v.opened_at, 'float', v.opening_float,
    'expected', round(coalesce(shift_expected_cash(v.id), v.opening_float), 2),
    'bills', (select count(*) from bills b
              where b.bar_id = p_bar and b.paid
                and b.settled_by_id is not distinct from v_id
                and b.settled_at >= v.opened_at)
  );
end $$;

create or replace function bar_shifts(p_bar uuid, p_from date, p_to date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cutoff int;
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;
  select coalesce(day_cutoff_hour, 5) into v_cutoff from bars where id = p_bar;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'staff', staff_name, 'openedAt', opened_at, 'closedAt', closed_at,
      'float', opening_float, 'expected', expected_cash,
      'declared', declared_cash, 'variance', variance, 'note', note
    ) order by opened_at desc), '[]'::jsonb)
    from shifts
    where bar_id = p_bar and closed_at is not null
      and business_day(opened_at, v_cutoff) between p_from and p_to
  );
end $$;

-- ---------------------------------------------------------------------------
-- Moving a table
-- ---------------------------------------------------------------------------

create or replace function transfer_order(p_order uuid, p_table uuid)
returns orders language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; t tables%rowtype; v_label text;
begin
  select * into o from orders where id = p_order;
  if not found then raise exception 'unknown_order'; end if;
  if not is_staff_of(o.bar_id) then raise exception 'not_your_bar'; end if;
  if o.status <> 'open' then raise exception 'order_already_closed'; end if;

  select t.* into t from tables t
  join zones z on z.id = t.zone_id
  where t.id = p_table and z.bar_id = o.bar_id;
  if not found then raise exception 'unknown_table'; end if;

  -- Two open orders on one table is how bills get mixed up.
  if exists (select 1 from orders where table_id = p_table and status = 'open' and id <> p_order) then
    raise exception 'table_already_open';
  end if;

  v_label := t.label;
  update orders set table_id = p_table, table_label = v_label where id = p_order
  returning * into o;

  insert into audit_log (bar_id, actor, event, subject, detail)
  values (o.bar_id, coalesce(auth.jwt() ->> 'staff_name', 'staff'),
          'table_moved', v_label, jsonb_build_object('orderId', o.id));

  return o;
end $$;

/** Push one table's order into another's. Same drink at the same price merges
    into one line rather than appearing twice on the guest's bill. */
create or replace function merge_orders(p_from uuid, p_into uuid)
returns orders language plpgsql security definer set search_path = public as $$
declare a orders%rowtype; b orders%rowtype;
begin
  if p_from = p_into then raise exception 'same_table'; end if;

  select * into a from orders where id = p_from;
  select * into b from orders where id = p_into;
  if a.id is null or b.id is null then raise exception 'unknown_order'; end if;
  if a.bar_id <> b.bar_id then raise exception 'not_your_bar'; end if;
  if not is_staff_of(a.bar_id) then raise exception 'not_your_bar'; end if;
  if a.status <> 'open' or b.status <> 'open' then raise exception 'order_already_closed'; end if;

  -- Same article at the same price: add the quantities together.
  update order_lines dst
     set qty = dst.qty + src.qty
  from order_lines src
  where src.order_id = p_from
    and dst.order_id = p_into
    and dst.article_id is not distinct from src.article_id
    and dst.unit_price = src.unit_price;

  delete from order_lines src
  where src.order_id = p_from
    and exists (select 1 from order_lines dst
                where dst.order_id = p_into
                  and dst.article_id is not distinct from src.article_id
                  and dst.unit_price = src.unit_price);

  -- Anything left is genuinely new to the destination.
  update order_lines set order_id = p_into where order_id = p_from;

  update orders set guests = b.guests + a.guests where id = p_into;
  update orders set status = 'closed', closed_at = now() where id = p_from;

  insert into audit_log (bar_id, actor, event, subject, detail)
  values (a.bar_id, coalesce(auth.jwt() ->> 'staff_name', 'staff'),
          'tables_merged', b.table_label,
          jsonb_build_object('from', a.table_label, 'into', b.table_label));

  select * into b from orders where id = p_into;
  return b;
end $$;

notify pgrst, 'reload schema';
