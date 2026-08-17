-- ===========================================================================
-- BACKBAR — part 8: guards against locking yourself out
-- Run AFTER the previous seven.
--
-- The Team screen listed the owner alongside the waiters, so an owner could
-- deactivate their own account and lose access to their own bar. The UI is
-- fixed, but the UI is the wrong place to enforce this — the rule belongs
-- where it cannot be bypassed.
-- ===========================================================================

create or replace function protect_last_owner() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_remaining int;
begin
  -- Only the platform may remove or disable an owner, and only if another
  -- owner would remain.
  if tg_op = 'DELETE' then
    if old.role <> 'owner' then return old; end if;
  else
    -- An UPDATE only matters if it disables the owner or demotes them.
    if old.role <> 'owner' then return new; end if;
    if new.active and new.role = 'owner' then return new; end if;
  end if;

  select count(*) into v_remaining
  from staff
  where bar_id = old.bar_id and role = 'owner' and active
    and id <> old.id;

  if v_remaining = 0 then
    raise exception 'A bar must keep one active owner. Ask the platform to reset the PIN instead.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists staff_protect_owner on staff;
create trigger staff_protect_owner
  before update or delete on staff
  for each row execute function protect_last_owner();

-- ---------------------------------------------------------------------------
-- The snapshot should say who the owner is, so the app stops guessing.
-- ---------------------------------------------------------------------------

create or replace function bar_snapshot(p_bar uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_owner boolean;
begin
  if not (is_staff_of(p_bar) or is_platform()) then raise exception 'not_your_bar'; end if;
  if not bar_is_live(p_bar) then raise exception 'subscription_inactive'; end if;
  v_owner := is_owner_of(p_bar) or is_platform();

  return jsonb_build_object(
    'bar', (
      select to_jsonb(b) - 'bar_code'
             || jsonb_build_object('owner_name',
                  (select name from staff where bar_id = b.id and role = 'owner' and active
                   order by created_at limit 1))
      from bars b where b.id = p_bar
    ),
    'zones', (
      select coalesce(jsonb_agg(z order by z.sort), '[]'::jsonb) from (
        select z.id, z.name, z.sort,
          (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
             from tables t where t.zone_id = z.id) as tables
        from zones z where z.bar_id = p_bar
      ) z
    ),
    'articles', (
      select coalesce(jsonb_agg(a), '[]'::jsonb) from (
        select id, name, category, sell_price, vat_rate, active,
               case when v_owner then cost_price else null end as cost_price
        from articles where bar_id = p_bar and active
        order by category, name
      ) a
    ),
    'openOrders', (
      select coalesce(jsonb_agg(o), '[]'::jsonb) from (
        select o.id, o.table_id, o.table_label, o.guests, o.opened_at,
               o.staff_id, o.staff_name,
               (select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb)
                  from order_lines l where l.order_id = o.id) as lines
        from orders o where o.bar_id = p_bar and o.status = 'open'
        order by o.opened_at
      ) o
    ),
    -- Waiters only. The owner is identified separately above, so the Team
    -- screen can never offer to delete the account you are signed in with.
    'staff', (
      select coalesce(jsonb_agg(s), '[]'::jsonb) from (
        select id, name, role from staff
        where bar_id = p_bar and active and role = 'waiter' and v_owner
        order by name
      ) s
    )
  );
end $$;

-- ---------------------------------------------------------------------------
-- Repair: if an owner already deactivated themselves before this guard existed,
-- this brings them back. Safe to run either way.
-- ---------------------------------------------------------------------------

update staff set active = true
where role = 'owner' and not active;

-- What each bar looks like now — every bar should show exactly one owner.
select b.name as bar,
       count(*) filter (where s.role = 'owner'  and s.active) as active_owners,
       count(*) filter (where s.role = 'waiter' and s.active) as waiters,
       string_agg(s.name || ' (' || s.role || ')', ', ' order by s.role, s.name) as people
from bars b
left join staff s on s.bar_id = b.id
group by b.id, b.name
order by b.name;
