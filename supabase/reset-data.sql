-- ===========================================================================
-- BACKBAR — part 10: start clean
-- Run AFTER the previous nine.
--
-- A bar tests for a week, then opens for real. Everything they set up should
-- survive; everything they rang through while learning should not.
--
--   goes:  bills, orders, order lines, day reports, fiscal log
--   stays: price list, floor plan, staff and PINs, branding, subscription
-- ===========================================================================

create or replace function bar_reset_preview(p_bar uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;

  return jsonb_build_object(
    'name',      (select name from bars where id = p_bar),
    'currency',  (select currency from bars where id = p_bar),
    -- what would be erased
    'bills',     (select count(*) from bills  where bar_id = p_bar),
    'takings',   (select coalesce(sum(total), 0) from bills where bar_id = p_bar and paid),
    'openOrders',(select count(*) from orders where bar_id = p_bar and status = 'open'),
    'firstBill', (select min(closed_at) from bills where bar_id = p_bar),
    'lastBill',  (select max(closed_at) from bills where bar_id = p_bar),
    -- the reason a reset might not be a good idea
    -- Only receipts from a real device count. A SIMULATOR print is a rehearsal.
    'fiscalReceipts', (select count(*) from bills where bar_id = p_bar
                        and fiscal_receipt_no is not null
                        and coalesce(fiscal_device, '') <> 'SIMULATOR'),
    'simulatedReceipts', (select count(*) from bills where bar_id = p_bar
                        and fiscal_receipt_no is not null
                        and coalesce(fiscal_device, '') = 'SIMULATOR'),
    -- what survives, so the decision is made knowing it
    'articles',  (select count(*) from articles where bar_id = p_bar and active),
    'tables',    (select count(*) from tables   where bar_id = p_bar),
    'staff',     (select count(*) from staff    where bar_id = p_bar and active)
  );
end $$;

-- ---------------------------------------------------------------------------
-- The reset itself.
--
-- p_confirm must equal the bar's name. And it refuses outright if any bill
-- carries a fiscal receipt number — those are issued records with a retention
-- period, and test data never has one. That single rule lets an owner clear
-- their own practice runs while making it impossible to quietly erase real
-- fiscalised trading.
-- ---------------------------------------------------------------------------

create or replace function reset_bar_data(
  p_bar uuid, p_confirm text, p_force boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v bars%rowtype; v_summary jsonb; v_fiscal int;
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;

  select * into v from bars where id = p_bar;
  if not found then raise exception 'unknown_bar'; end if;
  if p_confirm is distinct from v.name then raise exception 'confirmation_does_not_match'; end if;

  select count(*) into v_fiscal from bills
   where bar_id = p_bar and fiscal_receipt_no is not null
     and coalesce(fiscal_device, '') <> 'SIMULATOR';

  -- Only the platform may override, and only deliberately.
  if v_fiscal > 0 and not (p_force and is_platform()) then
    raise exception 'has_fiscal_receipts';
  end if;

  v_summary := bar_reset_preview(p_bar);

  insert into audit_log (bar_id, actor, event, subject, detail)
  values (p_bar, coalesce(nullif(jwt_staff_role(), ''), 'platform'),
          'bar_data_reset', v.name, v_summary);

  delete from cash_movements     where bar_id = p_bar;
  delete from fiscal_day_reports where bar_id = p_bar;
  delete from fiscal_log         where bar_id = p_bar;
  delete from bills              where bar_id = p_bar;
  delete from orders             where bar_id = p_bar;   -- order_lines cascade

  return v_summary;
end $$;
