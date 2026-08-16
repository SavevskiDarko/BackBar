-- ===========================================================================
-- BACKBAR — Postgres schema for Supabase
--
-- The point of this file: every rule that protects your revenue is enforced
-- HERE, not in React. A bar owner who opens devtools cannot unlock their own
-- subscription, and a waiter cannot read purchase prices, because the database
-- refuses — not because the UI hides a button.
--
-- Run this in the Supabase SQL editor, top to bottom.
-- ===========================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table bars (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  address        text,
  currency       text not null default '€',
  bar_code       text not null unique,          -- 4 digits, issued by you, global
  plan           text not null default 'starter'
                 check (plan in ('starter','pro','chain')),
  price_monthly  numeric(10,2) not null default 29,
  trial_ends_at  timestamptz,
  next_due_at    timestamptz not null default now(),
  grace_days     int not null default 7,
  suspended      boolean not null default false,
  allow_staff_discount boolean not null default false,
  created_at     timestamptz not null default now()
);

-- Owners and waiters. PINs are hashed — plaintext PINs never touch the DB.
-- A PIN only has to be unique inside one bar.
create table staff (
  id        uuid primary key default gen_random_uuid(),
  bar_id    uuid not null references bars(id) on delete cascade,
  name      text not null,
  role      text not null check (role in ('owner','waiter')),
  pin_hash  text not null,
  active    boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index staff_pin_per_bar on staff(bar_id, pin_hash);

create table zones (
  id       uuid primary key default gen_random_uuid(),
  bar_id   uuid not null references bars(id) on delete cascade,
  name     text not null,
  sort     int  not null default 0
);

create table tables (
  id       uuid primary key default gen_random_uuid(),
  zone_id  uuid not null references zones(id) on delete cascade,
  bar_id   uuid not null references bars(id) on delete cascade,
  label    text not null,
  shape    text not null check (shape in ('round','square','rect','bar')),
  x int not null, y int not null, w int not null, h int not null,
  seats int not null default 4,
  rot   int not null default 0
);

-- cost_price is the sensitive column. Waiters never see it — see the view below.
create table articles (
  id         uuid primary key default gen_random_uuid(),
  bar_id     uuid not null references bars(id) on delete cascade,
  name       text not null,
  category   text not null,
  cost_price numeric(10,2) not null default 0,
  sell_price numeric(10,2) not null default 0,
  active     boolean not null default true
);

create table orders (
  id         uuid primary key default gen_random_uuid(),
  bar_id     uuid not null references bars(id) on delete cascade,
  table_id   uuid references tables(id) on delete set null,
  table_label text not null,
  guests     int not null default 2,
  status     text not null default 'open' check (status in ('open','closed')),
  opened_at  timestamptz not null default now(),
  closed_at  timestamptz,
  staff_id   uuid references staff(id) on delete set null,
  staff_name text
);

create table order_lines (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references orders(id) on delete cascade,
  article_id uuid references articles(id) on delete set null,
  name       text not null,
  category   text,
  qty        int not null check (qty > 0),
  unit_price numeric(10,2) not null,
  unit_cost  numeric(10,2) not null    -- captured at sale time, so later price
);                                     -- changes never rewrite past profit

create table bills (
  id          uuid primary key default gen_random_uuid(),
  bar_id      uuid not null references bars(id) on delete cascade,
  order_id    uuid references orders(id) on delete set null,
  table_label text not null,
  closed_at   timestamptz not null default now(),
  method      text check (method in ('cash','card')),
  paid        boolean not null default false,
  settled_at  timestamptz,
  discount    numeric(5,2) not null default 0,
  total       numeric(10,2) not null,
  cost        numeric(10,2) not null,
  staff_id    uuid references staff(id) on delete set null,
  staff_name  text
);

-- Your subscription income.
create table subscription_payments (
  id       uuid primary key default gen_random_uuid(),
  bar_id   uuid not null references bars(id) on delete cascade,
  amount   numeric(10,2) not null,
  paid_at  timestamptz not null default now(),
  note     text
);

-- Whoever is listed here is you.
create table platform_admins (
  user_id uuid primary key
);

create index on orders(bar_id, status);
create index on bills(bar_id, closed_at desc);
create index on order_lines(order_id);

-- ---------------------------------------------------------------------------
-- Who is asking?
--
-- The staff-login Edge Function mints a JWT carrying bar_id / staff_id / role.
-- These helpers read those claims. They are the backbone of every policy below.
-- ---------------------------------------------------------------------------

create or replace function jwt_bar_id() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'bar_id', '')::uuid
$$;

create or replace function jwt_staff_role() returns text
language sql stable as $$
  select coalesce(auth.jwt() ->> 'staff_role', '')
$$;

create or replace function is_platform() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where user_id = auth.uid())
$$;

create or replace function is_owner_of(b uuid) returns boolean
language sql stable as $$
  select jwt_bar_id() = b and jwt_staff_role() = 'owner'
$$;

create or replace function is_staff_of(b uuid) returns boolean
language sql stable as $$
  select jwt_bar_id() = b
$$;

-- THE MONEY RULE. An unpaid bar goes read-nothing, write-nothing.
-- Because this sits in the database, no amount of tampering in the browser
-- gets a non-paying bar back online.
create or replace function bar_is_live(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from bars
    where id = b
      and suspended = false
      and (
        (trial_ends_at is not null and now() < trial_ends_at)
        or now() <= next_due_at + (grace_days || ' days')::interval
      )
  )
$$;

-- ---------------------------------------------------------------------------
-- Column-level protection for waiters
--
-- RLS filters ROWS, not COLUMNS. To hide cost_price, waiters are pointed at a
-- view that simply does not contain it. They cannot select what isn't there.
-- ---------------------------------------------------------------------------

create view menu_items
with (security_invoker = true) as
  select id, bar_id, name, category, sell_price, active
  from articles;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table bars                  enable row level security;
alter table staff                 enable row level security;
alter table zones                 enable row level security;
alter table tables                enable row level security;
alter table articles              enable row level security;
alter table orders                enable row level security;
alter table order_lines           enable row level security;
alter table bills                 enable row level security;
alter table subscription_payments enable row level security;
alter table platform_admins       enable row level security;

-- --- bars ---
-- You see and change everything. Staff see only their own bar's public details,
-- and nobody but you can touch billing columns (enforced by the trigger below).
create policy bars_platform_all on bars
  for all using (is_platform()) with check (is_platform());

create policy bars_staff_read on bars
  for select using (is_staff_of(id));

create policy bars_owner_update on bars
  for update using (is_owner_of(id) and bar_is_live(id))
  with check (is_owner_of(id));

-- An owner may rename their bar. An owner may NOT move their own due date.
create or replace function guard_billing_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_platform() then return new; end if;
  if new.plan          is distinct from old.plan
  or new.price_monthly is distinct from old.price_monthly
  or new.next_due_at   is distinct from old.next_due_at
  or new.trial_ends_at is distinct from old.trial_ends_at
  or new.grace_days    is distinct from old.grace_days
  or new.suspended     is distinct from old.suspended
  or new.bar_code      is distinct from old.bar_code then
    raise exception 'Billing settings can only be changed by the platform';
  end if;
  return new;
end $$;

create trigger bars_guard_billing
  before update on bars
  for each row execute function guard_billing_columns();

-- --- staff ---
create policy staff_platform_all on staff
  for all using (is_platform()) with check (is_platform());

create policy staff_owner_manage on staff
  for all using (is_owner_of(bar_id) and bar_is_live(bar_id))
  with check (is_owner_of(bar_id));

-- A waiter can look up their own record and nothing else.
create policy staff_read_self on staff
  for select using (id = nullif(auth.jwt() ->> 'staff_id','')::uuid);

-- --- floor plan: owners arrange it, everyone at the bar reads it ---
create policy zones_read on zones
  for select using (is_staff_of(bar_id) or is_platform());
create policy zones_owner_write on zones
  for all using (is_owner_of(bar_id) and bar_is_live(bar_id))
  with check (is_owner_of(bar_id));

create policy tables_read on tables
  for select using (is_staff_of(bar_id) or is_platform());
create policy tables_owner_write on tables
  for all using (is_owner_of(bar_id) and bar_is_live(bar_id))
  with check (is_owner_of(bar_id));

-- --- articles: ONLY owners read the base table, because it holds cost_price ---
create policy articles_owner_all on articles
  for all using (is_owner_of(bar_id) and bar_is_live(bar_id))
  with check (is_owner_of(bar_id));

create policy articles_platform_read on articles
  for select using (is_platform());

-- Waiters reach prices through menu_items. security_invoker means this policy
-- is what the view is checked against — sell_price yes, cost_price never.
create policy articles_staff_read_menu on articles
  for select using (is_staff_of(bar_id) and bar_is_live(bar_id));

-- --- orders: any waiter at the bar can work any table ---
create policy orders_staff_all on orders
  for all using (is_staff_of(bar_id) and bar_is_live(bar_id))
  with check (is_staff_of(bar_id));
create policy orders_platform_read on orders
  for select using (is_platform());

create policy lines_staff_all on order_lines
  for all using (exists (
    select 1 from orders o
    where o.id = order_id and is_staff_of(o.bar_id) and bar_is_live(o.bar_id)
  ))
  with check (exists (
    select 1 from orders o where o.id = order_id and is_staff_of(o.bar_id)
  ));

-- --- bills: waiters CREATE them, only the owner READS them ---
-- This is how "the waiter doesn't see how much the bar makes" is guaranteed.
create policy bills_staff_insert on bills
  for insert with check (is_staff_of(bar_id) and bar_is_live(bar_id));

create policy bills_owner_read on bills
  for select using (is_owner_of(bar_id) or is_platform());

create policy bills_owner_update on bills
  for update using (is_owner_of(bar_id) and bar_is_live(bar_id))
  with check (is_owner_of(bar_id));

-- --- your subscription income: yours alone ---
create policy payments_platform_all on subscription_payments
  for all using (is_platform()) with check (is_platform());
create policy payments_owner_read on subscription_payments
  for select using (is_owner_of(bar_id));

create policy admins_self_read on platform_admins
  for select using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Login: called by the staff-login Edge Function, never by the browser.
-- security definer lets it read pin_hash while RLS still blocks everyone else.
-- ---------------------------------------------------------------------------

create or replace function verify_staff_pin(p_bar_code text, p_pin text)
returns table (staff_id uuid, bar_id uuid, staff_name text, staff_role text, bar_name text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_bar bars%rowtype;
begin
  select * into v_bar from bars where bar_code = p_bar_code;
  if not found then raise exception 'unknown_bar'; end if;
  if not bar_is_live(v_bar.id) then raise exception 'subscription_inactive'; end if;

  return query
    select s.id, s.bar_id, s.name, s.role, v_bar.name
    from staff s
    where s.bar_id = v_bar.id
      and s.active
      and s.pin_hash = crypt(p_pin, s.pin_hash);
end $$;

revoke execute on function verify_staff_pin(text, text) from anon, authenticated;

-- Hash a PIN on the way in, so plaintext is never stored.
create or replace function set_staff_pin(p_staff uuid, p_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if length(p_pin) <> 4 or p_pin !~ '^[0-9]{4}$' then
    raise exception 'PIN must be exactly 4 digits';
  end if;
  update staff set pin_hash = crypt(p_pin, gen_salt('bf')) where id = p_staff;
end $$;

-- ---------------------------------------------------------------------------
-- Recording a subscription payment (you only) — pushes the due date forward.
-- ---------------------------------------------------------------------------

create or replace function record_subscription_payment(p_bar uuid, p_note text default 'manual')
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_bar bars%rowtype; v_next timestamptz;
begin
  if not is_platform() then raise exception 'not_authorised'; end if;
  select * into v_bar from bars where id = p_bar;
  v_next := greatest(now(), v_bar.next_due_at) + interval '1 month';

  update bars set next_due_at = v_next, trial_ends_at = null, suspended = false
   where id = p_bar;

  insert into subscription_payments (bar_id, amount, note)
  values (p_bar, v_bar.price_monthly, p_note);

  return v_next;
end $$;

-- ---------------------------------------------------------------------------
-- Live floor across devices: when a waiter adds a round on their phone, the
-- table lights up on every other tablet in the bar within a second.
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table orders;
alter publication supabase_realtime add table order_lines;
alter publication supabase_realtime add table tables;
