-- ===========================================================================
-- BACKBAR — part 9: removing a bar, and fuller product reporting
-- Run AFTER the previous eight.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- What deleting a bar would destroy.
--
-- Called before the confirmation dialog so the decision is made with the
-- numbers in view. Bills are fiscal records — in North Macedonia they carry a
-- retention obligation — so this should never be a one-click action.
-- ---------------------------------------------------------------------------

create or replace function bar_delete_preview(p_bar uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v bars%rowtype;
begin
  if not is_platform() then raise exception 'not_authorised'; end if;
  select * into v from bars where id = p_bar;
  if not found then raise exception 'unknown_bar'; end if;

  return jsonb_build_object(
    'name', v.name,
    'createdAt', v.created_at,
    'staff',    (select count(*) from staff    where bar_id = p_bar),
    'articles', (select count(*) from articles where bar_id = p_bar),
    'tables',   (select count(*) from tables   where bar_id = p_bar),
    'openOrders', (select count(*) from orders where bar_id = p_bar and status = 'open'),
    'bills',    (select count(*) from bills    where bar_id = p_bar),
    'takings',  (select coalesce(sum(total), 0) from bills where bar_id = p_bar and paid),
    'firstBill',(select min(closed_at) from bills where bar_id = p_bar),
    'lastBill', (select max(closed_at) from bills where bar_id = p_bar),
    'fiscalReceipts', (select count(*) from bills where bar_id = p_bar and fiscal_receipt_no is not null),
    'currency', v.currency
  );
end $$;

-- ---------------------------------------------------------------------------
-- Delete a bar and everything belonging to it.
--
-- p_confirm must equal the bar's name exactly. A typed name is a deliberate
-- act; a button press next to "Suspend" is a slip.
-- ---------------------------------------------------------------------------

create or replace function delete_bar(p_bar uuid, p_confirm text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v bars%rowtype; v_summary jsonb;
begin
  if not is_platform() then raise exception 'not_authorised'; end if;

  select * into v from bars where id = p_bar;
  if not found then raise exception 'unknown_bar'; end if;

  if p_confirm is distinct from v.name then
    raise exception 'confirmation_does_not_match';
  end if;

  -- Keep a record of what was removed. audit_log.bar_id is set null on
  -- delete, so the entry survives the bar itself.
  v_summary := bar_delete_preview(p_bar);

  insert into audit_log (bar_id, actor, event, subject, detail)
  values (p_bar, 'platform', 'bar_deleted', v.name, v_summary);

  -- Throttle rows key on the bar code, not a foreign key, so clear them here.
  delete from login_attempts where bar_code = v.bar_code;

  -- Everything else cascades: staff, zones, tables, articles, orders,
  -- order_lines, bills, fiscal_log, day reports, subscription payments.
  delete from bars where id = p_bar;

  return v_summary;
end $$;

-- ---------------------------------------------------------------------------
-- Product-level sales for the period.
--
-- The old report capped at 25 "best earners". An owner wants the whole list:
-- what sold, how many, for how much, and what it earned.
-- ---------------------------------------------------------------------------

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
  join order_lines l on l.order_id = b.order_id
  where b.bar_id = p_bar and b.paid and b.fiscal_status <> 'voided'
    and business_day(b.settled_at, v_cutoff) between p_from and p_to
  group by 1, 2;

  select coalesce(sum(s.gross), 0) into v_total from _sold s;

  return query
  select s.name, s.category, s.qty, s.gross, s.cost,
         round(s.gross - s.cost, 2) as profit,
         case when s.gross > 0 then round((s.gross - s.cost) / s.gross * 100, 1) else 0 end as margin,
         case when v_total > 0 then round(s.gross / v_total * 100, 1) else 0 end as share,
         s.vat_rate
  from _sold s
  order by s.gross desc;
end $$;
