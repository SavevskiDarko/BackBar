-- ===========================================================================
-- BACKBAR — part 10: start a bar clean after testing
-- Run AFTER the previous nine.
--
-- A bar tests for a few days, then opens properly. They want the practice
-- bills gone without losing the part that took effort: the floor plan, the
-- price list, the staff, the branding.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- What a reset would remove, and what survives it.
-- ---------------------------------------------------------------------------

create or replace function bar_reset_preview(p_bar uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v bars%rowtype;
begin
  if not is_platform() then raise exception 'not_authorised'; end if;
  select * into v from bars where id = p_bar;
  if not found then raise exception 'unknown_bar'; end if;

  return jsonb_build_object(
    'name', v.name,
    'currency', v.currency,
    -- goes
    'bills',      (select count(*) from bills  where bar_id = p_bar),
    'takings',    (select coalesce(sum(total),0) from bills where bar_id = p_bar and paid),
    'openOrders', (select count(*) from orders where bar_id = p_bar and status = 'open'),
    'dayReports', (select count(*) from fiscal_day_reports where bar_id = p_bar),
    -- the reason this is not simply "delete the bar": these carry a retention
    -- obligation, so a reset must refuse rather than quietly destroy them
    'fiscalReceipts', (select count(*) from bills where bar_id = p_bar and fiscal_receipt_no is not null),
    -- stays
    'articles', (select count(*) from articles where bar_id = p_bar and active),
    'tables',   (select count(*) from tables   where bar_id = p_bar),
    'zones',    (select count(*) from zones    where bar_id = p_bar),
    'staff',    (select count(*) from staff    where bar_id = p_bar and active)
  );
end $$;

-- ---------------------------------------------------------------------------
-- Clear the trading history, keep the setup.
--
-- Refuses if any bill carries a fiscal receipt number. During testing there
-- are none, so the case this is built for passes freely — and the case where
-- someone wants to erase real trading is blocked, which is the point.
-- ---------------------------------------------------------------------------

create or replace function reset_bar_trading(p_bar uuid, p_confirm text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v bars%rowtype; v_fiscal int; v_summary jsonb;
begin
  if not is_platform() then raise exception 'not_authorised'; end if;

  select * into v from bars where id = p_bar;
  if not found then raise exception 'unknown_bar'; end if;
  if p_confirm is distinct from v.name then raise exception 'confirmation_does_not_match'; end if;

  select count(*) into v_fiscal from bills
   where bar_id = p_bar and fiscal_receipt_no is not null;

  if v_fiscal > 0 then
    raise exception 'This bar has % fiscal receipts. Those are legal records and cannot be cleared here.', v_fiscal;
  end if;

  v_summary := bar_reset_preview(p_bar);

  insert into audit_log (bar_id, actor, event, subject, detail)
  values (p_bar, 'platform', 'trading_reset', v.name, v_summary);

  -- Bills first: orders would otherwise null their order_id on the way out.
  delete from bills               where bar_id = p_bar;
  delete from orders              where bar_id = p_bar;   -- order_lines cascade
  delete from fiscal_day_reports  where bar_id = p_bar;
  delete from fiscal_log          where bar_id = p_bar;

  -- Untouched on purpose: articles, zones, tables, staff, branding,
  -- subscription and payment history. That is the work worth keeping.
  return v_summary;
end $$;
