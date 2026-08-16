-- ===========================================================================
-- BACKBAR — part 2: the functions the app actually calls
-- Run this AFTER schema.sql.
--
-- Everything here exists because the browser cannot be trusted with it:
-- prices, totals, discount limits, login throttling, subscription dates.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Login throttling
--
-- A 4-digit PIN is 10,000 guesses. A script does that in minutes. No RLS
-- policies on this table means only service_role (the Edge Function) touches it.
-- ---------------------------------------------------------------------------

create table login_attempts (
  id       bigserial primary key,
  bar_code text not null,
  ip       text not null,
  ok       boolean not null,
  at       timestamptz not null default now()
);
create index login_attempts_lookup on login_attempts(bar_code, ip, at desc);
alter table login_attempts enable row level security;

create or replace function login_is_locked(p_bar_code text, p_ip text)
returns boolean language sql security definer set search_path = public as $$
  select count(*) >= 8
  from login_attempts
  where ip = p_ip
    and bar_code = p_bar_code
    and not ok
    and at > now() - interval '15 minutes'
$$;

create or replace function login_record(p_bar_code text, p_ip text, p_ok boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into login_attempts (bar_code, ip, ok) values (p_bar_code, p_ip, p_ok);
  -- On success, wipe the failures so an honest typo doesn't count against a shift.
  if p_ok then
    delete from login_attempts where ip = p_ip and bar_code = p_bar_code and not ok;
  end if;
  delete from login_attempts where at < now() - interval '1 day';
end $$;

-- Used by the pairing screen. Confirms a bar code without revealing anything
-- beyond the name, and only if the subscription is live.
create or replace function bar_public_info(p_bar_code text)
returns table (bar_id uuid, bar_name text)
language plpgsql security definer set search_path = public as $$
declare v bars%rowtype;
begin
  select * into v from bars where bar_code = p_bar_code;
  if not found then raise exception 'unknown_bar'; end if;
  if not bar_is_live(v.id) then raise exception 'subscription_inactive'; end if;
  return query select v.id, v.name;
end $$;

revoke execute on function login_is_locked(text,text)   from anon, authenticated;
revoke execute on function login_record(text,text,boolean) from anon, authenticated;
revoke execute on function bar_public_info(text)        from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Prices are stamped by the server, never accepted from the client
--
-- Without this, anyone can POST an order line with unit_price = 0.01 and walk
-- out having "paid". The trigger overwrites whatever the browser sent with the
-- real price from the articles table.
-- ---------------------------------------------------------------------------

create or replace function stamp_line_prices() returns trigger
language plpgsql security definer set search_path = public as $$
declare a articles%rowtype; o orders%rowtype;
begin
  select * into o from orders where id = new.order_id;
  if not found then raise exception 'unknown_order'; end if;

  select * into a from articles where id = new.article_id and bar_id = o.bar_id;
  if not found then raise exception 'article_not_on_this_bars_list'; end if;

  new.name       := a.name;
  new.category   := a.category;
  new.unit_price := a.sell_price;   -- ignores the client entirely
  new.unit_cost  := a.cost_price;
  return new;
end $$;

create trigger order_lines_stamp_prices
  before insert or update on order_lines
  for each row execute function stamp_line_prices();

-- ---------------------------------------------------------------------------
-- Closing a bill: one transaction, totals computed here
--
-- The old client code sent `total` along with the request. It no longer can.
-- Discount is clamped to what the owner allows.
-- ---------------------------------------------------------------------------

create or replace function close_order_and_bill(
  p_order    uuid,
  p_method   text,      -- 'cash' | 'card' | null when unpaid
  p_paid     boolean,
  p_discount numeric default 0
) returns bills
language plpgsql security definer set search_path = public as $$
declare
  o orders%rowtype; b bars%rowtype;
  v_gross numeric(10,2); v_cost numeric(10,2);
  v_disc numeric(5,2); v_total numeric(10,2);
  v_bill bills%rowtype;
begin
  select * into o from orders where id = p_order;
  if not found then raise exception 'unknown_order'; end if;
  if o.status = 'closed' then raise exception 'order_already_closed'; end if;
  if not is_staff_of(o.bar_id) then raise exception 'not_your_bar'; end if;
  if not bar_is_live(o.bar_id) then raise exception 'subscription_inactive'; end if;
  if p_paid and p_method not in ('cash','card') then raise exception 'bad_method'; end if;

  select * into b from bars where id = o.bar_id;

  -- A waiter only gets to discount if the owner switched it on.
  v_disc := coalesce(p_discount, 0);
  if v_disc < 0 or v_disc > 100 then raise exception 'bad_discount'; end if;
  if jwt_staff_role() <> 'owner' and not b.allow_staff_discount then
    v_disc := 0;
  end if;

  select coalesce(sum(unit_price * qty), 0), coalesce(sum(unit_cost * qty), 0)
    into v_gross, v_cost
    from order_lines where order_id = p_order;

  v_total := round(v_gross * (1 - v_disc / 100), 2);

  insert into bills (bar_id, order_id, table_label, method, paid, settled_at,
                     discount, total, cost, staff_id, staff_name)
  values (o.bar_id, o.id, o.table_label, p_method, p_paid,
          case when p_paid then now() end,
          v_disc, v_total, v_cost, o.staff_id, o.staff_name)
  returning * into v_bill;

  update orders set status = 'closed', closed_at = now() where id = p_order;

  return v_bill;
end $$;

-- Settling a bill that was left unpaid. Owners only.
create or replace function settle_bill(p_bill uuid, p_method text)
returns bills language plpgsql security definer set search_path = public as $$
declare v_bill bills%rowtype;
begin
  select * into v_bill from bills where id = p_bill;
  if not found then raise exception 'unknown_bill'; end if;
  if not is_owner_of(v_bill.bar_id) then raise exception 'owners_only'; end if;
  if p_method not in ('cash','card') then raise exception 'bad_method'; end if;

  update bills set paid = true, method = p_method, settled_at = now()
   where id = p_bill returning * into v_bill;
  return v_bill;
end $$;

-- ---------------------------------------------------------------------------
-- Platform: creating a bar and its owner in one go
-- ---------------------------------------------------------------------------

create or replace function new_bar_code() returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  loop
    c := lpad((1000 + floor(random() * 8999))::int::text, 4, '0');
    exit when not exists (select 1 from bars where bar_code = c);
  end loop;
  return c;
end $$;

create or replace function create_bar_with_owner(
  p_name text, p_address text, p_currency text,
  p_owner_name text, p_owner_pin text,
  p_plan text default 'starter', p_trial_days int default 14
) returns bars
language plpgsql security definer set search_path = public as $$
declare v_bar bars%rowtype; v_price numeric; v_trial timestamptz;
begin
  if not is_platform() then raise exception 'not_authorised'; end if;
  if p_owner_pin !~ '^[0-9]{4}$' then raise exception 'pin_must_be_4_digits'; end if;

  v_price := case p_plan when 'pro' then 59 when 'chain' then 119 else 29 end;
  v_trial := case when p_trial_days > 0
                  then now() + (p_trial_days || ' days')::interval end;

  insert into bars (name, address, currency, bar_code, plan, price_monthly,
                    trial_ends_at, next_due_at)
  values (p_name, p_address, coalesce(p_currency, '€'), new_bar_code(),
          p_plan, v_price, v_trial, coalesce(v_trial, now()))
  returning * into v_bar;

  insert into staff (bar_id, name, role, pin_hash)
  values (v_bar.id, p_owner_name, 'owner', crypt(p_owner_pin, gen_salt('bf')));

  insert into zones (bar_id, name, sort) values (v_bar.id, 'Main room', 0);

  return v_bar;
end $$;

create or replace function regenerate_bar_code(p_bar uuid)
returns text language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not is_platform() then raise exception 'not_authorised'; end if;
  c := new_bar_code();
  update bars set bar_code = c where id = p_bar;
  return c;
end $$;

create or replace function set_bar_suspended(p_bar uuid, p_suspended boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_platform() then raise exception 'not_authorised'; end if;
  update bars set suspended = p_suspended where id = p_bar;
end $$;

create or replace function set_bar_plan(p_bar uuid, p_plan text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_platform() then raise exception 'not_authorised'; end if;
  if p_plan not in ('starter','pro','chain') then raise exception 'bad_plan'; end if;
  update bars set plan = p_plan,
    price_monthly = case p_plan when 'pro' then 59 when 'chain' then 119 else 29 end
   where id = p_bar;
end $$;

-- Owners adding waiters. Hashes the PIN, refuses one already used at that bar.
create or replace function upsert_staff(
  p_staff uuid, p_bar uuid, p_name text, p_pin text
) returns staff
language plpgsql security definer set search_path = public as $$
declare v staff%rowtype;
begin
  if not (is_owner_of(p_bar) or is_platform()) then raise exception 'not_authorised'; end if;
  if p_pin is not null and p_pin !~ '^[0-9]{4}$' then raise exception 'pin_must_be_4_digits'; end if;

  if p_pin is not null and exists (
    select 1 from staff
    where bar_id = p_bar and id is distinct from p_staff
      and pin_hash = crypt(p_pin, pin_hash)
  ) then
    raise exception 'pin_taken_at_this_bar';
  end if;

  if p_staff is null then
    insert into staff (bar_id, name, role, pin_hash)
    values (p_bar, p_name, 'waiter', crypt(p_pin, gen_salt('bf')))
    returning * into v;
  else
    update staff
       set name = coalesce(p_name, name),
           pin_hash = case when p_pin is null then pin_hash
                           else crypt(p_pin, gen_salt('bf')) end
     where id = p_staff and bar_id = p_bar
    returning * into v;
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- One call to load a bar's whole day. Cheaper than six round trips on 4G.
-- ---------------------------------------------------------------------------

create or replace function bar_snapshot(p_bar uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_owner boolean;
begin
  if not (is_staff_of(p_bar) or is_platform()) then raise exception 'not_your_bar'; end if;
  if not bar_is_live(p_bar) then raise exception 'subscription_inactive'; end if;
  v_owner := is_owner_of(p_bar) or is_platform();

  return jsonb_build_object(
    'bar', (select to_jsonb(b) - 'bar_code' from bars b where b.id = p_bar),
    'zones', (
      select coalesce(jsonb_agg(z order by z.sort), '[]'::jsonb) from (
        select z.id, z.name, z.sort,
          (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
             from tables t where t.zone_id = z.id) as tables
        from zones z where z.bar_id = p_bar
      ) z
    ),
    -- Waiters get name and sell price. cost_price is simply not selected.
    'articles', (
      select coalesce(jsonb_agg(a), '[]'::jsonb) from (
        select id, name, category, sell_price, active,
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
    'staff', (
      select coalesce(jsonb_agg(s), '[]'::jsonb) from (
        select id, name, role from staff
        where bar_id = p_bar and active and v_owner
      ) s
    )
  );
end $$;
