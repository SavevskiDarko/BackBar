-- ===========================================================================
-- BACKBAR — part 18: the reorder list
--
-- Knowing something is low is not the same as knowing what to order. An owner
-- standing in front of a supplier needs "Campari — 6 bottles", grouped by who
-- they buy it from, in a form they can send.
--
-- par_level is read as the level you want ON the shelf, which is how bars use
-- the word. Below it, order enough whole packs to get back to it.
-- ===========================================================================

-- A par of zero means "never tell me", which is a fine choice but a poor
-- default — it makes the whole feature silent until someone tunes it. Two
-- packs is a sane starting point that an owner can change per ingredient.
alter table ingredients alter column par_level set default 0;

update ingredients
   set par_level = round(pack_size * 2, 3)
 where par_level = 0 and pack_size > 0;

create or replace function bar_reorder(p_bar uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;

  with short as (
    select i.id, i.name, i.unit, i.supplier,
           i.in_stock, i.par_level, i.pack_size, i.pack_cost,
           -- Whole packs only: nobody orders 0.4 of a bottle.
           greatest(1, ceil((i.par_level - i.in_stock) / nullif(i.pack_size, 0)))::int as packs
    from ingredients i
    where i.bar_id = p_bar and i.active
      and i.par_level > 0
      and i.in_stock <= i.par_level
  ),
  costed as (
    select *, round(packs * pack_cost, 2) as line_cost from short
  )
  select jsonb_build_object(
    'items', (select count(*) from costed),
    'total', (select coalesce(round(sum(line_cost), 2), 0) from costed),
    'suppliers', (
      select coalesce(jsonb_agg(s order by s.supplier nulls last), '[]'::jsonb)
      from (
        select coalesce(nullif(btrim(supplier), ''), 'No supplier set') as supplier,
               round(sum(line_cost), 2) as total,
               jsonb_agg(jsonb_build_object(
                 'id', id, 'name', name, 'unit', unit,
                 'inStock', in_stock, 'par', par_level,
                 'packSize', pack_size, 'packCost', pack_cost,
                 'packs', packs, 'lineCost', line_cost
               ) order by name) as items
        from costed
        group by 1
      ) s
    )
  ) into v_out;

  return v_out;
end $$;

notify pgrst, 'reload schema';
