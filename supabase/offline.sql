-- ===========================================================================
-- BACKBAR — part 3: offline-safe writes
-- Run this AFTER schema.sql and rpc.sql.
--
-- When a tablet loses wifi, orders queue locally and replay when it returns.
-- Replay means the same request can arrive twice: the waiter's tablet retries,
-- or the connection dies after the server committed but before the reply.
--
-- So every write here is idempotent. The client generates the row's UUID, and
-- sending the same operation twice produces the same result as sending it once.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Save a whole order in one transaction.
--
-- The client supplies the order id, which is what makes replay safe. Line
-- prices are still stamped by the server trigger — an offline tablet can hold
-- a stale menu, but it can never decide what something costs.
-- ---------------------------------------------------------------------------

create or replace function save_order_full(
  p_order      uuid,
  p_bar        uuid,
  p_table      uuid,
  p_label      text,
  p_guests     int,
  p_staff      uuid,
  p_staff_name text,
  p_opened_at  timestamptz,
  p_lines      jsonb          -- [{ "article_id": "...", "qty": 2 }, ...]
) returns orders
language plpgsql security definer set search_path = public, extensions as $$
declare v_order orders%rowtype; v_line jsonb;
begin
  if not is_staff_of(p_bar) then raise exception 'not_your_bar'; end if;
  if not bar_is_live(p_bar) then raise exception 'subscription_inactive'; end if;

  select * into v_order from orders where id = p_order;

  -- A bill that has already been closed must not be reopened by a late replay.
  if found and v_order.status = 'closed' then
    return v_order;
  end if;

  insert into orders (id, bar_id, table_id, table_label, guests, staff_id, staff_name, opened_at)
  values (p_order, p_bar, p_table, p_label, p_guests, p_staff, p_staff_name,
          coalesce(p_opened_at, now()))
  on conflict (id) do update
    set guests = excluded.guests,
        table_id = excluded.table_id,
        table_label = excluded.table_label
  returning * into v_order;

  -- Replace the lines wholesale: the payload is the complete intended state,
  -- so replaying it lands on the same result rather than doubling quantities.
  delete from order_lines where order_id = p_order;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    insert into order_lines (order_id, article_id, qty, name, unit_price, unit_cost)
    values (p_order, (v_line->>'article_id')::uuid, greatest(1, (v_line->>'qty')::int),
            '', 0, 0);   -- overwritten by the stamp_line_prices trigger
  end loop;

  return v_order;
end $$;

-- ---------------------------------------------------------------------------
-- Close a bill, idempotently.
--
-- The old version raised 'order_already_closed'. That was right for a live
-- connection and wrong for replay: a retry would fail forever and stick in the
-- outbox. Now a second call returns the bill that already exists.
-- ---------------------------------------------------------------------------

drop function if exists close_order_and_bill(uuid, text, boolean, numeric);

create or replace function close_order_and_bill(
  p_order    uuid,
  p_method   text,
  p_paid     boolean,
  p_discount numeric default 0,
  p_bill     uuid default null      -- client-supplied, so retries match up
) returns bills
language plpgsql security definer set search_path = public, extensions as $$
declare
  o orders%rowtype; b bars%rowtype;
  v_gross numeric(10,2); v_cost numeric(10,2);
  v_disc numeric(5,2); v_total numeric(10,2);
  v_bill bills%rowtype;
begin
  select * into o from orders where id = p_order;
  if not found then raise exception 'unknown_order'; end if;
  if not is_staff_of(o.bar_id) then raise exception 'not_your_bar'; end if;
  if not bar_is_live(o.bar_id) then raise exception 'subscription_inactive'; end if;

  -- Already closed? Hand back the same bill instead of failing.
  select * into v_bill from bills where order_id = p_order limit 1;
  if found then return v_bill; end if;

  if p_paid and p_method not in ('cash','card') then raise exception 'bad_method'; end if;

  select * into b from bars where id = o.bar_id;

  v_disc := coalesce(p_discount, 0);
  if v_disc < 0 or v_disc > 100 then raise exception 'bad_discount'; end if;
  if jwt_staff_role() <> 'owner' and not b.allow_staff_discount then
    v_disc := 0;
  end if;

  select coalesce(sum(unit_price * qty), 0), coalesce(sum(unit_cost * qty), 0)
    into v_gross, v_cost
    from order_lines where order_id = p_order;

  v_total := round(v_gross * (1 - v_disc / 100), 2);

  insert into bills (id, bar_id, order_id, table_label, method, paid, settled_at,
                     discount, total, cost, staff_id, staff_name)
  values (coalesce(p_bill, gen_random_uuid()), o.bar_id, o.id, o.table_label,
          p_method, p_paid, case when p_paid then now() end,
          v_disc, v_total, v_cost, o.staff_id, o.staff_name)
  on conflict (id) do nothing
  returning * into v_bill;

  if v_bill.id is null then
    select * into v_bill from bills where id = p_bill;
  end if;

  update orders set status = 'closed', closed_at = now() where id = p_order;

  return v_bill;
end $$;

-- One bill per order, enforced rather than assumed — this is what stops a
-- double replay from billing a table twice.
create unique index if not exists bills_one_per_order on bills(order_id)
  where order_id is not null;

-- A deleted order should take its lines with it (already true), and a client
-- may cancel an order it created while offline.
create or replace function cancel_order(p_order uuid)
returns void language plpgsql security definer set search_path = public as $$
declare o orders%rowtype;
begin
  select * into o from orders where id = p_order;
  if not found then return; end if;   -- already gone: nothing to do
  if not is_staff_of(o.bar_id) then raise exception 'not_your_bar'; end if;
  if o.status = 'closed' then raise exception 'order_already_closed'; end if;
  delete from orders where id = p_order;
end $$;
