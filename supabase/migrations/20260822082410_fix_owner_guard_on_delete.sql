-- ===========================================================================
-- FIX: "A bar must keep one active owner" when deleting a bar
--
-- The guard was doing its job too well. Deleting a bar cascades to its staff,
-- the cascade removes the owner row, and the trigger blocked it — so a bar
-- could never be deleted at all.
--
-- Two escapes were missing:
--   1. the bar itself is being deleted, so keeping its owner is meaningless
--   2. the platform is acting deliberately
-- ===========================================================================

create or replace function protect_last_owner() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_remaining int; v_row record;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;

  -- Only owner rows are protected at all.
  if old.role <> 'owner' then return v_row; end if;

  -- An update that leaves them an active owner is not a removal.
  if tg_op = 'UPDATE' and new.active and new.role = 'owner' then
    return new;
  end if;

  -- The bar is being deleted. Postgres runs ON DELETE CASCADE after the parent
  -- row is gone, so its absence is how we recognise a cascade rather than
  -- someone deleting a person.
  if not exists (select 1 from bars where id = old.bar_id) then
    return v_row;
  end if;

  -- The platform can replace an owner deliberately.
  if is_platform() then return v_row; end if;

  select count(*) into v_remaining
  from staff
  where bar_id = old.bar_id and role = 'owner' and active and id <> old.id;

  if v_remaining = 0 then
    raise exception 'A bar must keep one active owner. Ask the platform to reset the PIN instead.';
  end if;

  return v_row;
end $$;

-- Deleting the bar should not be blocked by rows that are about to vanish
-- anyway, so clear the staff first and let the trigger see an empty field.
create or replace function delete_bar(p_bar uuid, p_confirm text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v bars%rowtype; v_summary jsonb;
begin
  if not is_platform() then raise exception 'not_authorised'; end if;

  select * into v from bars where id = p_bar;
  if not found then raise exception 'unknown_bar'; end if;
  if p_confirm is distinct from v.name then raise exception 'confirmation_does_not_match'; end if;

  v_summary := bar_delete_preview(p_bar);

  insert into audit_log (bar_id, actor, event, subject, detail)
  values (p_bar, 'platform', 'bar_deleted', v.name, v_summary);

  delete from login_attempts where bar_code = v.bar_code;
  delete from bars where id = p_bar;

  return v_summary;
end $$;
