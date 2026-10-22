-- ===========================================================================
-- BACKBAR — part 20: sales that were rung up before the item had a buy price
--
-- articles.cost_price defaults to 0 and is NOT NULL, so "I haven't entered
-- what this costs me" and "this costs me nothing" are the same value. The
-- stamping trigger copies that 0 onto the sale, and because a stamped cost is
-- deliberately never rewritten — a price change must not alter last month's
-- profit — those sales keep a cost of zero for good.
--
-- Downstream, profit is gross minus cost, so every one of those units reports
-- as 100% profit. An item sold eleven times for 1,100 shows a profit of 1,100.
-- Entering the buy price afterwards does not move it, and the existing warning
-- ("N articles have no buy price") disappears the moment it is entered, while
-- the old sales go on overstating the takings silently.
--
-- Two halves to this, and both are needed:
--
--   1. Report what is actually known. A product whose units were partly sold
--      before the price existed has a profit figure for that part only. Saying
--      so is the difference between a number that is incomplete and a number
--      that is wrong.
--
--   2. Let the owner fill the gap. Backfilling a cost onto sales that never
--      recorded one is not rewriting history — there is no history there to
--      rewrite. It is the missing figure arriving late. Sales that DID record
--      a cost are never touched, so a genuine price change still cannot reach
--      back into a closed month.
--
-- Run AFTER the previous nineteen.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- What sold before a cost was known
--
-- Reported per product alongside the totals, so the owner can see that a
-- profit covers nine of eleven units rather than guessing.
--
-- Dropped first, not replaced: two columns are being added and `create or
-- replace` cannot change a function's OUT parameters. Nothing is lost with it
-- — this function carries no grants of its own, and the guard that matters is
-- the is_owner_of check in its body.
-- ---------------------------------------------------------------------------
drop function if exists bar_products_sold(uuid, date, date);

create or replace function bar_products_sold(
  p_bar uuid, p_from date, p_to date
) returns table (
  name text, category text, qty bigint,
  gross numeric, cost numeric, profit numeric,
  margin numeric, share numeric, vat_rate numeric,
  qty_costed bigint, gross_costed numeric
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
         -- The units that carry a cost, and what they sold for. Profit is only
         -- knowable across these.
         coalesce(sum(l.qty) filter (where l.unit_cost > 0), 0)::bigint as qty_costed,
         round(coalesce(sum(l.unit_price * l.qty * (1 - b.discount / 100))
                        filter (where l.unit_cost > 0), 0), 2) as gross_costed,
         max(l.vat_rate) as vat_rate
  from bills b
  join bill_lines l on l.bill_id = b.id
  where b.bar_id = p_bar and b.paid and b.fiscal_status <> 'voided'
    and business_day(b.settled_at, v_cutoff) between p_from and p_to
  group by 1, 2;

  select coalesce(sum(s.gross), 0) into v_total from _sold s;

  return query
  select s.name, s.category, s.qty, s.gross, s.cost,
         -- Against gross_costed, not gross: charging the uncosted units' whole
         -- takings to profit is exactly the overstatement this file is about.
         round(s.gross_costed - s.cost, 2),
         case when s.gross_costed > 0
              then round((s.gross_costed - s.cost) / s.gross_costed * 100, 1)
              else 0 end,
         -- Share of the night is a share of everything sold, costed or not.
         case when v_total > 0 then round(s.gross / v_total * 100, 1) else 0 end,
         s.vat_rate,
         s.qty_costed, s.gross_costed
  from _sold s
  order by s.gross desc;
end $$;

-- ---------------------------------------------------------------------------
-- How much of one article's history has no cost on it
--
-- Called when a buy price is entered, so the offer to backfill can say what it
-- would actually touch instead of asking in the abstract.
-- ---------------------------------------------------------------------------
create or replace function article_uncosted_sales(p_bar uuid, p_article uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;

  select jsonb_build_object(
    'units', coalesce(sum(l.qty), 0),
    'gross', coalesce(round(sum(l.unit_price * l.qty * (1 - b.discount / 100)), 2), 0),
    'first', min(b.settled_at),
    'last',  max(b.settled_at)
  ) into v_out
  from bills b
  join bill_lines l on l.bill_id = b.id
  where b.bar_id = p_bar and b.paid and b.fiscal_status <> 'voided'
    and l.article_id = p_article and l.unit_cost = 0;

  return coalesce(v_out, jsonb_build_object('units', 0, 'gross', 0));
end $$;

-- ---------------------------------------------------------------------------
-- Put the cost onto the sales that never had one
--
-- `unit_cost = 0` is the whole filter, and it is what keeps this safe: a line
-- that recorded a real cost is left exactly as it was, so this can never be
-- used to restate a month that was priced correctly at the time.
-- ---------------------------------------------------------------------------
create or replace function backfill_article_cost(
  p_bar uuid, p_article uuid, p_cost numeric
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_lines int := 0; v_units int := 0; v_bills int := 0;
        v_open int := 0; v_voids int := 0;
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;
  if p_cost is null or p_cost <= 0 then raise exception 'cost_must_be_positive'; end if;
  if not exists (select 1 from articles where id = p_article and bar_id = p_bar) then
    raise exception 'article_not_on_this_bars_list';
  end if;

  -- Tables still open. Their bills have not been written yet, so fixing these
  -- stops tonight adding to the problem.
  update order_lines l set unit_cost = p_cost
    from orders o
   where l.order_id = o.id and o.bar_id = p_bar
     and l.article_id = p_article and l.unit_cost = 0;
  get diagnostics v_open = row_count;

  -- The closed bills, which is what every report actually reads.
  create temp table _touched on commit drop as
  with upd as (
    update bill_lines l set unit_cost = p_cost
      from bills b
     where l.bill_id = b.id and b.bar_id = p_bar
       and l.article_id = p_article and l.unit_cost = 0
    returning l.bill_id, l.qty
  )
  select bill_id, qty from upd;

  select count(*), coalesce(sum(qty), 0), count(distinct bill_id)
    into v_lines, v_units, v_bills from _touched;

  -- bills.cost is a stored total, not a view over the lines, so the headline
  -- profit in Money keeps the old figure unless it is recomputed here.
  update bills b
     set cost = (select coalesce(sum(bl.unit_cost * bl.qty), 0)
                   from bill_lines bl where bl.bill_id = b.id)
   where b.id in (select distinct bill_id from _touched);

  -- A comped drink still cost the bar something; that is the point of tracking
  -- them. Same rule: only the ones that never recorded a cost.
  update order_voids v set unit_cost = p_cost
   where v.bar_id = p_bar and v.article_id = p_article and v.unit_cost = 0;
  get diagnostics v_voids = row_count;

  return jsonb_build_object(
    'lines', v_lines, 'units', v_units, 'bills', v_bills,
    'openLines', v_open, 'voids', v_voids);
end $$;
