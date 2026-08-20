-- ===========================================================================
-- BACKBAR — part 12: changing your own PIN
--
-- The platform sets the owner's PIN when a bar is created, so at that moment
-- the platform knows it. An owner should be able to change it to something
-- only they know, and see when it was last reset by anyone else.
-- ===========================================================================

create or replace function change_own_pin(p_current text, p_new text)
returns void language plpgsql security definer
set search_path = public, extensions as $$
declare v_id uuid; v staff%rowtype;
begin
  v_id := nullif(auth.jwt() ->> 'staff_id', '')::uuid;
  if v_id is null then raise exception 'not_signed_in'; end if;

  select * into v from staff where id = v_id and active;
  if not found then raise exception 'not_signed_in'; end if;

  -- Knowing the current PIN is the whole point: a token alone must not be
  -- enough to lock the real owner out of their own bar.
  if v.pin_hash <> crypt(p_current, v.pin_hash) then
    raise exception 'current_pin_wrong';
  end if;

  if p_new !~ '^[0-9]{4}$' then raise exception 'pin_must_be_4_digits'; end if;
  if p_new = p_current then raise exception 'pin_unchanged'; end if;

  -- Still unique inside this bar; other bars are on their own devices.
  if exists (
    select 1 from staff
    where bar_id = v.bar_id and id <> v.id and active
      and pin_hash = crypt(p_new, pin_hash)
  ) then raise exception 'pin_taken_at_this_bar'; end if;

  update staff set pin_hash = crypt(p_new, gen_salt('bf')) where id = v.id;

  insert into audit_log (bar_id, actor, event, subject)
  values (v.bar_id, v.id::text, 'own_pin_changed', v.name);
end $$;

-- ---------------------------------------------------------------------------
-- Who has touched this bar's sign-in recently.
--
-- An owner should be able to see that the platform reset their PIN, and when.
-- Transparency is worth more here than the feature itself.
-- ---------------------------------------------------------------------------

create or replace function bar_security_events(p_bar uuid, p_limit int default 10)
returns table (at timestamptz, event text, actor text, subject text)
language plpgsql security definer set search_path = public as $$
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;
  return query
    select a.at, a.event,
           case when a.actor = 'platform' then 'the platform' else 'someone at this bar' end,
           a.subject
    from audit_log a
    where a.bar_id = p_bar
      and a.event in ('owner_pin_reset','staff_pin_reset','own_pin_changed','bar_data_reset')
    order by a.at desc
    limit greatest(1, least(p_limit, 50));
end $$;

notify pgrst, 'reload schema';
