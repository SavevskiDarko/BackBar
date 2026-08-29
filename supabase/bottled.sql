-- ===========================================================================
-- BACKBAR — part 19: things sold as they come
--
-- A Negroni is MADE from ingredients. A bottle of Skopsko is not made from
-- anything — it is the thing. Asking an owner to declare a beer as an
-- ingredient of itself, at a quantity of one, is bookkeeping the app should do
-- for itself.
--
-- The model underneath stays the same, so deliveries, counts, the reorder list
-- and variance all keep working untouched. What changes is that setting it up
-- is one tick instead of four steps.
-- ===========================================================================

-- When set, this ingredient IS that article rather than something that goes
-- into it. That is what lets the editor show the right form.
alter table ingredients
  add column if not exists article_id uuid references articles(id) on delete cascade;

create unique index if not exists ingredients_one_per_article
  on ingredients(article_id) where article_id is not null;

/**
 * Make an article stock-tracked in its own right.
 *
 * p_units_per_pack — how many come in a case, so deliveries are counted the way
 *                    they actually arrive
 * p_unit_cost      — what one bottle costs you
 */
create or replace function link_article_stock(
  p_article uuid, p_units_per_pack numeric default 24, p_unit_cost numeric default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare a articles%rowtype; v_ing ingredients%rowtype; v_pack numeric;
begin
  select * into a from articles where id = p_article;
  if not found then raise exception 'unknown_article'; end if;
  if not is_owner_of(a.bar_id) then raise exception 'owners_only'; end if;

  v_pack := greatest(1, coalesce(p_units_per_pack, 1));

  select * into v_ing from ingredients where article_id = p_article;

  if found then
    update ingredients
       set name = a.name, unit = 'piece', pack_size = v_pack,
           pack_cost = round(coalesce(p_unit_cost, 0) * v_pack, 2),
           active = true
     where id = v_ing.id;
  else
    -- A name clash with a hand-made ingredient would be confusing, so take the
    -- article's name and let the unique index on (bar_id, name) complain if
    -- someone has already created one by hand.
    insert into ingredients (bar_id, name, unit, pack_size, pack_cost, article_id, par_level)
    values (a.bar_id, a.name, 'piece', v_pack,
            round(coalesce(p_unit_cost, 0) * v_pack, 2), p_article, v_pack * 2)
    returning * into v_ing;
  end if;

  -- One of itself. The recipe machinery is untouched; it just has a trivial
  -- recipe to work with, so depletion, costing and variance all behave.
  delete from recipe_items where article_id = p_article;
  insert into recipe_items (article_id, ingredient_id, qty)
  values (p_article, v_ing.id, 1);

  update articles set cost_price = article_recipe_cost(p_article) where id = p_article;

  return jsonb_build_object(
    'ingredientId', v_ing.id, 'unitsPerPack', v_pack,
    'unitCost', coalesce(p_unit_cost, 0), 'inStock', v_ing.in_stock);
end $$;

/** Back to being made from things. Keeps the stock record — the bottles on the
    shelf did not stop existing because someone changed their mind. */
create or replace function unlink_article_stock(p_article uuid)
returns void language plpgsql security definer set search_path = public as $$
declare a articles%rowtype;
begin
  select * into a from articles where id = p_article;
  if not found then raise exception 'unknown_article'; end if;
  if not is_owner_of(a.bar_id) then raise exception 'owners_only'; end if;

  delete from recipe_items where article_id = p_article;
  update ingredients set article_id = null where article_id = p_article;
end $$;

-- ---------------------------------------------------------------------------
-- The recipe view now says which kind of article this is.
-- ---------------------------------------------------------------------------

create or replace function article_recipe(p_article uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_bar uuid; v_self ingredients%rowtype;
begin
  select bar_id into v_bar from articles where id = p_article;
  if v_bar is null then raise exception 'unknown_article'; end if;
  if not (is_owner_of(v_bar) or is_platform()) then raise exception 'owners_only'; end if;

  select * into v_self from ingredients where article_id = p_article and active;

  return jsonb_build_object(
    'cost', article_recipe_cost(p_article),
    -- Present when the article is sold as it comes.
    'self', case when v_self.id is not null then jsonb_build_object(
      'ingredientId', v_self.id, 'unitsPerPack', v_self.pack_size,
      'unitCost', ingredient_unit_cost(v_self.*), 'inStock', v_self.in_stock,
      'parLevel', v_self.par_level, 'supplier', v_self.supplier) end,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'ingredientId', r.ingredient_id, 'name', i.name, 'unit', i.unit,
        'qty', r.qty, 'unitCost', ingredient_unit_cost(i.*),
        'lineCost', round(r.qty * ingredient_unit_cost(i.*), 2)) order by i.name), '[]'::jsonb)
      from recipe_items r join ingredients i on i.id = r.ingredient_id
      where r.article_id = p_article and i.article_id is null)
  );
end $$;

-- Ingredients that are really articles shouldn't clutter the recipe picker.
create or replace function bar_stock(p_bar uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;

  return jsonb_build_object(
    'items', (
      select coalesce(jsonb_agg(x order by x.low desc, x.name), '[]'::jsonb) from (
        select i.id, i.name, i.unit, i.pack_size, i.pack_cost, i.in_stock,
               i.par_level, i.supplier, i.article_id,
               (i.article_id is not null) as is_article,
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

notify pgrst, 'reload schema';
