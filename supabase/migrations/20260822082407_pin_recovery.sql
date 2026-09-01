-- ===========================================================================
-- BACKBAR — part 7: PIN recovery
-- Run AFTER the previous six.
--
-- A bar owner will forget their PIN. Until now the only fix was hand-written
-- SQL, which does not survive fifty customers.
--
-- PINs are bcrypt hashed and cannot be read back — not by the owner, not by
-- you. So recovery means setting a NEW one, never revealing the old.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Audit trail
--
-- Resetting a PIN grants access to every figure a bar has. That is exactly the
-- kind of action that needs a record of who did it and when — for your own
-- protection as much as the customer's.
-- ---------------------------------------------------------------------------

create table if not exists audit_log (
  id      bigserial primary key,
  bar_id  uuid references bars(id) on delete set null,
  at      timestamptz not null default now(),
  actor   text not null,          -- 'platform' or the staff id that acted
  event   text not null,          -- 'owner_pin_reset' | 'staff_pin_reset' | ...
  subject text,                   -- who it was done to
  detail  jsonb
);
create index if not exists audit_log_bar_at on audit_log(bar_id, at desc);

alter table audit_log enable row level security;

create policy audit_owner_read on audit_log
  for select using (is_owner_of(bar_id) or is_platform());

-- ---------------------------------------------------------------------------
-- A PIN worth issuing
--
-- Avoids the handful people actually guess first. Not security theatre — a
-- four-digit space is small enough that skipping 1234 and 0000 matters.
-- ---------------------------------------------------------------------------

create or replace function suggest_pin() returns text
language plpgsql volatile as $$
declare c text; banned text[] := array['0000','1111','2222','3333','4444','5555',
                                       '6666','7777','8888','9999','1234','4321','1212'];
begin
  loop
    c := lpad(floor(random() * 10000)::int::text, 4, '0');
    exit when not (c = any(banned));
  end loop;
  return c;
end $$;

-- ---------------------------------------------------------------------------
-- You resetting a bar owner's PIN
--
-- Platform only. Returns the new PIN, which is the single moment it is ever
-- visible — after this it exists only as a hash.
-- ---------------------------------------------------------------------------

create or replace function reset_owner_pin(p_bar uuid, p_pin text default null)
returns text language plpgsql security definer
set search_path = public, extensions as $$
declare v_pin text; v_staff uuid; v_name text;
begin
  if not is_platform() then raise exception 'not_authorised'; end if;

  select id, name into v_staff, v_name
  from staff where bar_id = p_bar and role = 'owner' and active
  order by created_at limit 1;

  if v_staff is null then raise exception 'no_owner_for_this_bar'; end if;

  v_pin := coalesce(nullif(p_pin, ''), suggest_pin());
  if v_pin !~ '^[0-9]{4}$' then raise exception 'pin_must_be_4_digits'; end if;

  -- A PIN only has to be unique inside its own bar.
  if exists (
    select 1 from staff
    where bar_id = p_bar and id <> v_staff and active
      and pin_hash = crypt(v_pin, pin_hash)
  ) then
    raise exception 'pin_taken_at_this_bar';
  end if;

  update staff set pin_hash = crypt(v_pin, gen_salt('bf')), active = true
   where id = v_staff;

  insert into audit_log (bar_id, actor, event, subject, detail)
  values (p_bar, 'platform', 'owner_pin_reset', v_name,
          jsonb_build_object('generated', p_pin is null));

  return v_pin;
end $$;

-- ---------------------------------------------------------------------------
-- An owner resetting one of their waiters
-- ---------------------------------------------------------------------------

create or replace function reset_staff_pin(p_staff uuid, p_pin text default null)
returns text language plpgsql security definer
set search_path = public, extensions as $$
declare v_bar uuid; v_pin text; v_name text; v_role text;
begin
  select bar_id, name, role into v_bar, v_name, v_role from staff where id = p_staff;
  if v_bar is null then raise exception 'unknown_staff'; end if;
  if not (is_owner_of(v_bar) or is_platform()) then raise exception 'owners_only'; end if;

  -- An owner cannot reset another owner's PIN; that stays with the platform.
  if v_role = 'owner' and not is_platform() then raise exception 'not_authorised'; end if;

  v_pin := coalesce(nullif(p_pin, ''), suggest_pin());
  if v_pin !~ '^[0-9]{4}$' then raise exception 'pin_must_be_4_digits'; end if;

  if exists (
    select 1 from staff
    where bar_id = v_bar and id <> p_staff and active and pin_hash = crypt(v_pin, pin_hash)
  ) then
    raise exception 'pin_taken_at_this_bar';
  end if;

  update staff set pin_hash = crypt(v_pin, gen_salt('bf')) where id = p_staff;

  insert into audit_log (bar_id, actor, event, subject)
  values (v_bar, coalesce(nullif(jwt_staff_role(), ''), 'platform'), 'staff_pin_reset', v_name);

  return v_pin;
end $$;

-- ---------------------------------------------------------------------------
-- Who the owner should contact — shown on the "forgotten PIN" screen, so a
-- locked-out owner has a name and not just a shrug.
-- ---------------------------------------------------------------------------

alter table bars add column if not exists support_contact text;

create or replace function bar_support_info(p_bar_code text)
returns table (bar_name text, owner_name text, support text)
language plpgsql security definer set search_path = public as $$
declare v bars%rowtype;
begin
  select * into v from bars where bar_code = p_bar_code;
  if not found then raise exception 'unknown_bar'; end if;
  return query
    select v.name,
           (select name from staff where bar_id = v.id and role = 'owner' and active
            order by created_at limit 1),
           v.support_contact;
end $$;

revoke execute on function bar_support_info(text) from anon, authenticated;
revoke execute on function suggest_pin() from anon, authenticated;
