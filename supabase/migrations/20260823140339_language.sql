-- ===========================================================================
-- BACKBAR — part 14: language
--
-- What the staff read on the floor. Set per bar by its owner; before anyone
-- signs in, the device's own language decides.
-- ===========================================================================

alter table bars
  add column if not exists language text not null default 'en';

do $$ begin
  alter table bars add constraint bars_language_known
    check (language in ('en','mk'));
exception when duplicate_object then null; end $$;

-- The pairing screen shows the bar's language before anyone has a token.
drop function if exists bar_public_info(text);

create or replace function bar_public_info(p_bar_code text)
returns table (bar_id uuid, bar_name text, accent text, surface text,
               logo_path text, language text)
language plpgsql security definer set search_path = public as $$
declare v bars%rowtype;
begin
  select * into v from bars where bar_code = p_bar_code;
  if not found then raise exception 'unknown_bar'; end if;
  if not bar_is_live(v.id) then raise exception 'subscription_inactive'; end if;
  return query select v.id, v.name, v.brand_accent, v.brand_surface, v.logo_path, v.language;
end $$;

revoke execute on function bar_public_info(text) from anon, authenticated;

notify pgrst, 'reload schema';
