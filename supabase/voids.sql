-- ===========================================================================
-- BACKBAR — part 15: voids and comps
--
-- The oldest trick in hospitality: ring a drink up, serve it, delete the line,
-- keep the cash. Until now the app left no trace of it.
--
-- The rule drawn here: anything already saved to the table is accountable.
-- Removing it needs a reason and records who did it. A waiter who mistypes and
-- hasn't saved yet can still fix it freely — that isn't abuse, it's typing.
--
-- Comps are separate from voids on purpose. "On the house" is a real business
-- decision an owner wants totalled; a spilled drink is a different number.
-- ===========================================================================

create table if not exists order_voids (
  id         uuid primary key default gen_random_uuid(),
  bar_id     uuid not null references bars(id) on delete cascade,
  order_id   uuid references orders(id) on delete set null,
  article_id uuid references articles(id) on delete set null,
  name       text not null,
  category   text,
  qty        int  not null check (qty > 0),
  unit_price numeric(10,2) not null,
  unit_cost  numeric(10,2) not null default 0,
  kind       text not null check (kind in ('void','comp')),
  reason     text not null,
  at         timestamptz not null default now(),
  staff_id   uuid references staff(id) on delete set null,
  staff_name text,
  table_label text
);
create index if not exists order_voids_bar_at on order_voids(bar_id, at desc);

alter table order_voids enable row level security;

drop policy if exists voids_staff_insert on order_voids;
create policy voids_staff_insert on order_voids
  for insert with check (is_staff_of(bar_id) and bar_is_live(bar_id));

-- Waiters can't read these back. The point is the owner sees them.
drop policy if exists voids_owner_read on order_voids;
create policy voids_owner_read on order_voids
  for select using (is_owner_of(bar_id) or is_platform());

-- ---------------------------------------------------------------------------
-- Removing something from a saved table
--
-- p_qty is how many to take off. A reason is required — that is the entire
-- point, so it is enforced here rather than in the UI where it could be
-- skipped by anything talking to the API directly.
-- ---------------------------------------------------------------------------

create or replace function void_order_line(
  p_line   uuid,
  p_qty    int,
  p_reason text,
  p_kind   text default 'void'
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
                           unit_price, unit_cost, kind, reason,
                           staff_id, staff_name, table_label)
  values (o.bar_id, o.id, l.article_id, l.name, l.category, v_take,
          l.unit_price, l.unit_cost, p_kind, btrim(p_reason),
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

-- ---------------------------------------------------------------------------
-- What was taken off tables, and by whom
-- ---------------------------------------------------------------------------

create or replace function bar_voids(p_bar uuid, p_from date, p_to date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cutoff int; v_out jsonb;
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;
  select coalesce(day_cutoff_hour, 5) into v_cutoff from bars where id = p_bar;

  with scoped as (
    select v.*, round(v.unit_price * v.qty, 2) as value
    from order_voids v
    where v.bar_id = p_bar
      and business_day(v.at, v_cutoff) between p_from and p_to
  )
  select jsonb_build_object(
    'voidCount', (select coalesce(sum(qty), 0) from scoped where kind = 'void'),
    'voidValue', (select coalesce(sum(value), 0) from scoped where kind = 'void'),
    'compCount', (select coalesce(sum(qty), 0) from scoped where kind = 'comp'),
    'compValue', (select coalesce(sum(value), 0) from scoped where kind = 'comp'),

    'byReason', (select coalesce(jsonb_agg(jsonb_build_object(
        'reason', reason, 'kind', kind, 'qty', q, 'value', val) order by val desc), '[]'::jsonb)
      from (select reason, kind, sum(qty) q, round(sum(value), 2) val
            from scoped group by 1, 2) r),

    -- The one an owner actually studies. A waiter voiding far more than the
    -- rest is not proof of anything, but it is where to look.
    'byStaff', (select coalesce(jsonb_agg(jsonb_build_object(
        'name', staff_name, 'qty', q, 'value', val) order by val desc), '[]'::jsonb)
      from (select coalesce(staff_name, 'unknown') as staff_name,
                   sum(qty) q, round(sum(value), 2) val
            from scoped group by 1) s),

    'recent', (select coalesce(jsonb_agg(jsonb_build_object(
        'at', at, 'name', name, 'qty', qty, 'value', value, 'kind', kind,
        'reason', reason, 'staff', staff_name, 'table', table_label) order by at desc), '[]'::jsonb)
      from (select * from scoped order by at desc limit 30) x)
  ) into v_out;

  return v_out;
end $$;

notify pgrst, 'reload schema';
