-- ===========================================================================
-- BACKBAR — part 21: the bills themselves
--
-- Money shows what was taken and what sold, but not what any one person
-- actually ordered. "12 bills · avg 363" is a summary of twelve things you
-- cannot look at. When an owner wants to check a table that argued about its
-- bill, or see whether the 400 at 21:14 was one round or four, there is
-- nowhere to look — bar_report_rows has the lines but it is built for the
-- accountant's CSV export, flat and ungrouped.
--
-- So: the bills, newest first, each carrying its own lines.
--
-- Paid bills only, matching every other figure in Money. Unpaid ones have
-- their own panel, because an unpaid bill is a thing to chase rather than a
-- thing to read.
--
-- Run AFTER the previous twenty.
-- ===========================================================================

create or replace function bar_bills(
  p_bar uuid, p_from date, p_to date, p_limit int default 200
) returns table (
  id uuid, settled_at timestamptz, table_label text, staff text,
  method text, total numeric, discount numeric, receipt_no text, lines jsonb
) language plpgsql security definer set search_path = public as $$
declare v_cutoff int;
begin
  -- Bills are the owner's: a waiter must not read back what the bar took.
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;
  -- `bars` is aliased because this function returns a column called `id`, and
  -- an unqualified `where id = p_bar` cannot tell that OUT parameter from the
  -- table's own column. Postgres rejects it as ambiguous.
  select coalesce(br.day_cutoff_hour, 5) into v_cutoff from bars br where br.id = p_bar;

  return query
  select b.id, b.settled_at, b.table_label, b.staff_name, b.method,
         b.total, b.discount, b.fiscal_receipt_no,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'name', l.name,
                    'qty', l.qty,
                    'unitPrice', l.unit_price,
                    -- The discount is on the bill, so a line's share of it has
                    -- to be applied here or the lines won't add up to the total.
                    'lineTotal', round(l.unit_price * l.qty * (1 - b.discount / 100), 2))
                  order by l.name)
           from bill_lines l
          where l.bill_id = b.id), '[]'::jsonb)
  from bills b
  where b.bar_id = p_bar and b.paid and b.fiscal_status <> 'voided'
    and business_day(b.settled_at, v_cutoff) between p_from and p_to
  order by b.settled_at desc
  -- A month in a busy bar is thousands of bills and this is a thing to read,
  -- not a dataset. The newest cover the question being asked; the CSV export
  -- is there for the whole period.
  limit greatest(1, least(coalesce(p_limit, 200), 500));
end $$;
