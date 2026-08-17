-- ===========================================================================
-- BACKBAR — part 6: per-bar branding
-- Run AFTER the previous five.
-- ===========================================================================

alter table bars
  add column if not exists brand_accent  text,
  add column if not exists brand_surface text,
  add column if not exists logo_path     text;   -- path inside the logos bucket

do $$ begin
  alter table bars add constraint bars_surface_known
    check (brand_surface is null or brand_surface in ('bottle','midnight','charcoal','espresso'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table bars add constraint bars_accent_hex
    check (brand_accent is null or brand_accent ~* '^#[0-9a-f]{6}$');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Logo storage
--
-- Public read: the logo appears on the sign-in screen, before anyone has a
-- token, so it cannot require auth. Writes are locked to the bar's own owner.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('logos', 'logos', true, 524288,
        array['image/png','image/jpeg','image/webp','image/svg+xml'])
on conflict (id) do update
  set public = true,
      file_size_limit = 524288,
      allowed_mime_types = array['image/png','image/jpeg','image/webp','image/svg+xml'];

-- The filename is the bar's uuid, so ownership is decidable from the path alone.
create or replace function logo_bar_id(p_name text)
returns uuid language plpgsql immutable as $$
begin
  return split_part(p_name, '.', 1)::uuid;
exception when others then return null;
end $$;

drop policy if exists "logos are public" on storage.objects;
create policy "logos are public" on storage.objects
  for select using (bucket_id = 'logos');

drop policy if exists "owner writes own logo" on storage.objects;
create policy "owner writes own logo" on storage.objects
  for insert with check (
    bucket_id = 'logos' and is_owner_of(logo_bar_id(name))
  );

drop policy if exists "owner updates own logo" on storage.objects;
create policy "owner updates own logo" on storage.objects
  for update using (bucket_id = 'logos' and is_owner_of(logo_bar_id(name)));

drop policy if exists "owner deletes own logo" on storage.objects;
create policy "owner deletes own logo" on storage.objects
  for delete using (bucket_id = 'logos' and is_owner_of(logo_bar_id(name)));

-- ---------------------------------------------------------------------------
-- The pairing screen needs branding before anyone signs in — that is the
-- moment the app should already look like the bar's own.
-- ---------------------------------------------------------------------------

drop function if exists bar_public_info(text);

create or replace function bar_public_info(p_bar_code text)
returns table (bar_id uuid, bar_name text, accent text, surface text, logo_path text)
language plpgsql security definer set search_path = public as $$
declare v bars%rowtype;
begin
  select * into v from bars where bar_code = p_bar_code;
  if not found then raise exception 'unknown_bar'; end if;
  if not bar_is_live(v.id) then raise exception 'subscription_inactive'; end if;
  return query select v.id, v.name, v.brand_accent, v.brand_surface, v.logo_path;
end $$;

revoke execute on function bar_public_info(text) from anon, authenticated;

-- Owners may set their own branding; the guard trigger already blocks them
-- from touching billing columns on the same table.
create or replace function set_branding(p_bar uuid, p_accent text, p_surface text)
returns bars language plpgsql security definer set search_path = public as $$
declare v bars%rowtype;
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;
  if p_accent is not null and p_accent !~* '^#[0-9a-f]{6}$' then raise exception 'bad_accent'; end if;
  update bars set brand_accent = p_accent, brand_surface = p_surface
   where id = p_bar returning * into v;
  return v;
end $$;

create or replace function set_logo_path(p_bar uuid, p_path text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'owners_only'; end if;
  update bars set logo_path = p_path where id = p_bar;
end $$;
