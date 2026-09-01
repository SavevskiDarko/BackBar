-- ===========================================================================
-- FIX: "unknown_order" when deleting a bar
--
-- order_lines.article_id is ON DELETE SET NULL. Deleting a bar cascades to its
-- articles, and nulling that column is an UPDATE — which fired the
-- price-stamping trigger, which then went looking for an order that the same
-- cascade had already removed.
--
-- The trigger only ever needed to run when a line is created or its article or
-- quantity actually changes. It should not run for housekeeping updates.
-- ===========================================================================

create or replace function stamp_line_prices() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare a articles%rowtype; o orders%rowtype;
begin
  -- A cascade nulling the article reference, not a real edit.
  if new.article_id is null then return new; end if;

  -- Nothing price-relevant changed, so leave the stamped values alone.
  -- They are a record of the sale, not a live lookup.
  if tg_op = 'UPDATE'
     and new.article_id is not distinct from old.article_id
     and new.qty is not distinct from old.qty then
    return new;
  end if;

  select * into o from orders where id = new.order_id;
  if not found then return new; end if;   -- the order is going away with it

  select * into a from articles where id = new.article_id and bar_id = o.bar_id;
  if not found then raise exception 'article_not_on_this_bars_list'; end if;

  new.name       := a.name;
  new.category   := a.category;
  new.unit_price := a.sell_price;   -- ignores whatever the client sent
  new.unit_cost  := a.cost_price;
  new.vat_rate   := a.vat_rate;     -- the rate as at this sale
  return new;
end $$;

-- Narrow the trigger too, so it isn't woken by unrelated column changes.
drop trigger if exists order_lines_stamp_prices on order_lines;
create trigger order_lines_stamp_prices
  before insert or update of article_id, qty on order_lines
  for each row execute function stamp_line_prices();
