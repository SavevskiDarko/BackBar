-- ===========================================================================
-- BACKBAR — part 16: stock
--
-- Until now the app could say what was SOLD. A bar owner's real question is
-- what was POURED — because the gap between the two is theft, over-pouring and
-- waste, and that gap is where the money goes.
--
-- Five pieces that are only useful together:
--   ingredients   what you buy: a 700ml bottle of Campari at 1,200 ден
--   recipes       what a drink is made of: a Negroni is 3cl of three things
--   deliveries    stock coming in
--   depletion     every paid bill quietly takes stock out
--   variance      what should be on the shelf against what is
--
-- It also fixes the cost prices. Nobody can tell you what a Negroni costs, but
-- anyone can tell you a bottle costs 1,200 ден and the pour is 3cl.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Ingredients
--
-- Everything is held in a base unit — ml, g, or piece — so a 0.7l bottle and a
-- 3cl pour are the same currency. Buying happens in packs; pouring happens in
-- base units. Keeping both is what makes the cost per pour computable.
-- ---------------------------------------------------------------------------

create table if not exists ingredients (
  id         uuid primary key default gen_random_uuid(),
  bar_id     uuid not null references bars(id) on delete cascade,
  name       text not null,
  unit       text not null default 'ml' check (unit in ('ml','g','piece')),
  pack_size  numeric(12,3) not null check (pack_size > 0),   -- base units per pack
  pack_cost  numeric(12,2) not null default 0,               -- what a pack costs
  in_stock   numeric(12,3) not null default 0,               -- base units on hand
  par_level  numeric(12,3) not null default 0,               -- reorder point
  supplier   text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (bar_id, name)
);
create index if not exists ingredients_bar on ingredients(bar_id) where active;

alter table ingredients enable row level security;

drop policy if exists ingredients_owner on ingredients;
create policy ingredients_owner on ingredients
  for all using (is_owner_of(bar_id) or is_platform())
  with check (is_owner_of(bar_id));

-- Waiters never see cost. They don't need this table at all.

create or replace function ingredient_unit_cost(i ingredients)
returns numeric language sql immutable as $$
  select case when i.pack_size > 0 then round(i.pack_cost / i.pack_size, 6) else 0 end
$$;

-- ---------------------------------------------------------------------------
-- Recipes
--
-- What a menu item is made of. An article with no recipe simply has no
-- computed cost — which is honest, and visible, rather than silently zero.
-- ---------------------------------------------------------------------------

create table if not exists recipe_items (
  id            uuid primary key default gen_random_uuid(),
  article_id    uuid not null references articles(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  qty           numeric(12,3) not null check (qty > 0),      -- base units per serving
  unique (article_id, ingredient_id)
);
create index if not exists recipe_items_article on recipe_items(article_id);

alter table recipe_items enable row level security;

drop policy if exists recipe_owner on recipe_items;
create policy recipe_owner on recipe_items
  for all using (exists (
    select 1 from articles a where a.id = article_id
      and (is_owner_of(a.bar_id) or is_platform())))
  with check (exists (
    select 1 from articles a where a.id = article_id and is_owner_of(a.bar_id)));

/** What one serving costs, from its recipe. */
create or replace function article_recipe_cost(p_article uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(round(sum(r.qty * ingredient_unit_cost(i.*)), 2), 0)
  from recipe_items r
  join ingredients i on i.id = r.ingredient_id
  where r.article_id = p_article
$$;

/** Push recipe costs onto the articles, so every existing report keeps working
    without knowing recipes exist. Anything without a recipe is left alone —
    a hand-entered cost is still better than nothing. */
create or replace function recalc_article_costs(p_bar uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;

  with costed as (
    select a.id, article_recipe_cost(a.id) as c
    from articles a
    where a.bar_id = p_bar
      and exists (select 1 from recipe_items r where r.article_id = a.id)
  )
  update articles a set cost_price = costed.c
  from costed where a.id = costed.id and a.cost_price is distinct from costed.c;

  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Movements
--
-- Every change to a shelf, with a reason. Signed: positive in, negative out.
-- The running `in_stock` on the ingredient is a convenience; this table is the
-- truth, and it is what variance is computed from.
-- ---------------------------------------------------------------------------

create table if not exists stock_movements (
  id            uuid primary key default gen_random_uuid(),
  bar_id        uuid not null references bars(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  at            timestamptz not null default now(),
  kind          text not null check (kind in ('delivery','sale','waste','count','correction')),
  qty           numeric(12,3) not null,          -- signed, in base units
  unit_cost     numeric(12,6) not null default 0,
  bill_id       uuid references bills(id) on delete set null,
  reason        text,
  staff_id      uuid references staff(id) on delete set null,
  staff_name    text
);
create index if not exists stock_moves_bar_at on stock_movements(bar_id, at desc);
create index if not exists stock_moves_ing on stock_movements(ingredient_id, at desc);

alter table stock_movements enable row level security;

drop policy if exists stock_moves_owner_read on stock_movements;
create policy stock_moves_owner_read on stock_movements
  for select using (is_owner_of(bar_id) or is_platform());

-- Sales are written by a security-definer function, so staff need no direct
-- insert. Everything else is the owner's.
drop policy if exists stock_moves_owner_write on stock_movements;
create policy stock_moves_owner_write on stock_movements
  for insert with check (is_owner_of(bar_id));

-- ---------------------------------------------------------------------------
-- Depletion
--
-- When a bill is paid, the drinks on it came off the shelf. Runs once per
-- bill — a replayed payment must not deplete twice.
-- ---------------------------------------------------------------------------

alter table bills add column if not exists depleted_at timestamptz;

create or replace function deplete_for_bill(p_bill uuid)
returns int language plpgsql security definer set search_path = public as $$
declare b bills%rowtype; n int := 0;
begin
  select * into b from bills where id = p_bill;
  if not found or b.depleted_at is not null then return 0; end if;

  insert into stock_movements (bar_id, ingredient_id, kind, qty, unit_cost, bill_id, staff_name)
  select b.bar_id, r.ingredient_id, 'sale',
         -(r.qty * l.qty), ingredient_unit_cost(i.*), b.id, b.staff_name
  from bill_lines l
  join recipe_items r on r.article_id = l.article_id
  join ingredients i on i.id = r.ingredient_id
  where l.bill_id = p_bill;

  get diagnostics n = row_count;

  update ingredients i set in_stock = i.in_stock - x.used
  from (
    select r.ingredient_id, sum(r.qty * l.qty) as used
    from bill_lines l
    join recipe_items r on r.article_id = l.article_id
    where l.bill_id = p_bill
    group by 1
  ) x
  where i.id = x.ingredient_id;

  update bills set depleted_at = now() where id = p_bill;
  return n;
end $$;

create or replace function bills_deplete_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.paid and new.depleted_at is null and new.fiscal_status <> 'voided' then
    perform deplete_for_bill(new.id);
  end if;
  return new;
end $$;

drop trigger if exists bills_deplete on bills;
create trigger bills_deplete
  after insert or update of paid on bills
  for each row execute function bills_deplete_trigger();

-- A drink that was made and then spilled came off the shelf too. One that was
-- rung up in error never did. The reason decides, which is why voids record it.
alter table order_voids add column if not exists consumed boolean not null default false;

create or replace function deplete_for_void(p_void uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v order_voids%rowtype;
begin
  select * into v from order_voids where id = p_void;
  if not found or not v.consumed or v.article_id is null then return; end if;

  insert into stock_movements (bar_id, ingredient_id, kind, qty, unit_cost, reason, staff_name)
  select v.bar_id, r.ingredient_id, 'waste',
         -(r.qty * v.qty), ingredient_unit_cost(i.*),
         v.kind || ': ' || v.reason, v.staff_name
  from recipe_items r
  join ingredients i on i.id = r.ingredient_id
  where r.article_id = v.article_id;

  update ingredients i set in_stock = i.in_stock - x.used
  from (select r.ingredient_id, sum(r.qty * v.qty) as used
        from recipe_items r where r.article_id = v.article_id group by 1) x
  where i.id = x.ingredient_id;
end $$;

create or replace function voids_deplete_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.consumed then perform deplete_for_void(new.id); end if;
  return new;
end $$;

drop trigger if exists voids_deplete on order_voids;
create trigger voids_deplete after insert on order_voids
  for each row execute function voids_deplete_trigger();

-- ---------------------------------------------------------------------------
-- Deliveries and stocktakes
-- ---------------------------------------------------------------------------

create or replace function receive_delivery(p_bar uuid, p_items jsonb, p_note text default null)
returns int language plpgsql security definer set search_path = public as $$
declare it jsonb; n int := 0; v_ing ingredients%rowtype; v_units numeric;
begin
  if not is_owner_of(p_bar) then raise exception 'owners_only'; end if;

  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    select * into v_ing from ingredients where id = (it->>'ingredient_id')::uuid and bar_id = p_bar;
    if not found then raise exception 'unknown_ingredient'; end if;

    -- Deliveries arrive in packs, not millilitres.
    v_units := (it->>'packs')::numeric * v_ing.pack_size;
    if v_units <= 0 then continue; end if;

    -- A price on the delivery note updates what a pack costs, so margins
    -- follow the real world rather than whatever was typed months ago.
    if nullif(it->>'pack_cost','') is not null then
      update ingredients set pack_cost = (it->>'pack_cost')::numeric where id = v_ing.id;
      v_ing.pack_cost := (it->>'pack_cost')::numeric;
    end if;

    insert into stock_movements (bar_id, ingredient_id, kind, qty, unit_cost, reason)
    values (p_bar, v_ing.id, 'delivery', v_units,
            case when v_ing.pack_size > 0 then round(v_ing.pack_cost / v_ing.pack_size, 6) else 0 end,
            p_note);

    update ingredients set in_stock = in_stock + v_units where id = v_ing.id;
    n := n + 1;
  end loop;

  perform recalc_article_costs(p_bar);
  return n;
end $$;

/** Counting the shelf. Records the difference rather than silently overwriting,
    because the difference is the entire point of counting. */
create or replace function record_stocktake(p_bar uuid, p_counts jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare it jsonb; v_ing ingredients%rowtype; v_counted numeric; v_diff numeric;
        v_lines jsonb := '[]'::jsonb; v_value numeric := 0;
begin
  if not is_owner_of(p_bar) then raise exception 'owners_only'; end if;

  for it in select * from jsonb_array_elements(coalesce(p_counts, '[]'::jsonb))
  loop
    select * into v_ing from ingredients where id = (it->>'ingredient_id')::uuid and bar_id = p_bar;
    if not found then continue; end if;

    v_counted := (it->>'counted')::numeric;         -- base units actually there
    v_diff := round(v_counted - v_ing.in_stock, 3);

    if v_diff <> 0 then
      insert into stock_movements (bar_id, ingredient_id, kind, qty, unit_cost, reason)
      values (p_bar, v_ing.id, 'count', v_diff,
              case when v_ing.pack_size > 0 then round(v_ing.pack_cost / v_ing.pack_size, 6) else 0 end,
              coalesce(p_note, 'stocktake'));

      update ingredients set in_stock = v_counted where id = v_ing.id;

      v_value := v_value + v_diff *
        (case when v_ing.pack_size > 0 then v_ing.pack_cost / v_ing.pack_size else 0 end);

      v_lines := v_lines || jsonb_build_object(
        'name', v_ing.name, 'expected', v_ing.in_stock, 'counted', v_counted,
        'difference', v_diff, 'unit', v_ing.unit);
    else
      update ingredients set in_stock = v_counted where id = v_ing.id;
    end if;
  end loop;

  return jsonb_build_object('lines', v_lines, 'value', round(v_value, 2));
end $$;

-- ---------------------------------------------------------------------------
-- What's on the shelf, and what it's worth
-- ---------------------------------------------------------------------------

create or replace function bar_stock(p_bar uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;

  return jsonb_build_object(
    'items', (
      select coalesce(jsonb_agg(x order by x.low desc, x.name), '[]'::jsonb) from (
        select i.id, i.name, i.unit, i.pack_size, i.pack_cost, i.in_stock,
               i.par_level, i.supplier,
               ingredient_unit_cost(i.*) as unit_cost,
               round(i.in_stock * ingredient_unit_cost(i.*), 2) as value,
               round(i.in_stock / nullif(i.pack_size, 0), 2) as packs,
               (i.par_level > 0 and i.in_stock <= i.par_level) as low,
               (select count(*) from recipe_items r where r.ingredient_id = i.id) as used_in
        from ingredients i where i.bar_id = p_bar and i.active
      ) x
    ),
    'totalValue', (
      select coalesce(round(sum(i.in_stock * ingredient_unit_cost(i.*)), 2), 0)
      from ingredients i where i.bar_id = p_bar and i.active
    ),
    'lowCount', (
      select count(*) from ingredients i
      where i.bar_id = p_bar and i.active and i.par_level > 0 and i.in_stock <= i.par_level
    ),
    'noRecipe', (
      select count(*) from articles a
      where a.bar_id = p_bar and a.active
        and not exists (select 1 from recipe_items r where r.article_id = a.id)
    )
  );
end $$;

/** The recipe for one article, ready to edit. */
create or replace function article_recipe(p_article uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_bar uuid;
begin
  select bar_id into v_bar from articles where id = p_article;
  if v_bar is null then raise exception 'unknown_article'; end if;
  if not (is_owner_of(v_bar) or is_platform()) then raise exception 'owners_only'; end if;

  return jsonb_build_object(
    'cost', article_recipe_cost(p_article),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'ingredientId', r.ingredient_id, 'name', i.name, 'unit', i.unit,
        'qty', r.qty, 'unitCost', ingredient_unit_cost(i.*),
        'lineCost', round(r.qty * ingredient_unit_cost(i.*), 2)) order by i.name), '[]'::jsonb)
      from recipe_items r join ingredients i on i.id = r.ingredient_id
      where r.article_id = p_article)
  );
end $$;

create or replace function set_recipe(p_article uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_bar uuid; it jsonb;
begin
  select bar_id into v_bar from articles where id = p_article;
  if v_bar is null then raise exception 'unknown_article'; end if;
  if not is_owner_of(v_bar) then raise exception 'owners_only'; end if;

  delete from recipe_items where article_id = p_article;

  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    if (it->>'qty')::numeric > 0 then
      insert into recipe_items (article_id, ingredient_id, qty)
      values (p_article, (it->>'ingredientId')::uuid, (it->>'qty')::numeric)
      on conflict (article_id, ingredient_id) do update set qty = excluded.qty;
    end if;
  end loop;

  -- The article's cost is now whatever its recipe says.
  update articles set cost_price = article_recipe_cost(p_article) where id = p_article;

  return article_recipe(p_article);
end $$;

-- ---------------------------------------------------------------------------
-- Variance: what should be there against what was counted
-- ---------------------------------------------------------------------------

create or replace function bar_variance(p_bar uuid, p_from date, p_to date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cutoff int;
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;
  select coalesce(day_cutoff_hour, 5) into v_cutoff from bars where id = p_bar;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', name, 'unit', unit,
      'delivered', delivered, 'sold', sold, 'wasted', wasted,
      'counted', counted, 'value', value) order by abs(counted) desc), '[]'::jsonb)
    from (
      select i.name, i.unit,
             round(coalesce(sum(m.qty) filter (where m.kind = 'delivery'), 0), 2) as delivered,
             round(-coalesce(sum(m.qty) filter (where m.kind = 'sale'), 0), 2) as sold,
             round(-coalesce(sum(m.qty) filter (where m.kind = 'waste'), 0), 2) as wasted,
             -- A count movement IS the variance: the correction someone had to
             -- make because the shelf disagreed with the books.
             round(coalesce(sum(m.qty) filter (where m.kind = 'count'), 0), 2) as counted,
             round(coalesce(sum(m.qty * m.unit_cost) filter (where m.kind = 'count'), 0), 2) as value
      from stock_movements m
      join ingredients i on i.id = m.ingredient_id
      where m.bar_id = p_bar
        and business_day(m.at, v_cutoff) between p_from and p_to
      group by i.id, i.name, i.unit
      having coalesce(sum(m.qty) filter (where m.kind = 'count'), 0) <> 0
    ) v
  );
end $$;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- void_order_line now records whether the drink was actually made, because
-- that decides whether stock moved.
-- ---------------------------------------------------------------------------

create or replace function void_order_line(
  p_line uuid, p_qty int, p_reason text,
  p_kind text default 'void', p_consumed boolean default false
) returns order_voids
language plpgsql security definer set search_path = public as $$
declare l order_lines%rowtype; o orders%rowtype; v order_voids%rowtype; v_take int;
begin
  select * into l from order_lines where id = p_line;
  if not found then raise exception 'line_not_on_this_table'; end if;

  select * into o from orders where id = l.order_id;
  if not found then raise exception 'unknown_order'; end if;
  if not is_staff_of(o.bar_id) then raise exception 'not_your_bar'; end if;
  if not bar_is_live(o.bar_id) then raise exception 'subscription_inactive'; end if;
  if o.status = 'closed' then raise exception 'order_already_closed'; end if;
  if p_kind not in ('void','comp') then raise exception 'bad_kind'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;

  v_take := greatest(1, coalesce(p_qty, 1));
  if v_take > l.qty then raise exception 'more_than_is_on_the_table'; end if;

  insert into order_voids (bar_id, order_id, article_id, name, category, qty,
                           unit_price, unit_cost, kind, reason, consumed,
                           staff_id, staff_name, table_label)
  values (o.bar_id, o.id, l.article_id, l.name, l.category, v_take,
          l.unit_price, l.unit_cost, p_kind, btrim(p_reason), coalesce(p_consumed, false),
          nullif(auth.jwt() ->> 'staff_id', '')::uuid,
          coalesce(auth.jwt() ->> 'staff_name', o.staff_name),
          o.table_label)
  returning * into v;

  if v_take = l.qty then
    delete from order_lines where id = p_line;
  else
    update order_lines set qty = qty - v_take where id = p_line;
  end if;

  return v;
end $$;

notify pgrst, 'reload schema';
