-- ===========================================================================
-- FIX: "That item isn't on this table any more" when paying part of a bill
--
-- The split matched by article_id, which is a guess about which row is meant.
-- Matching the order line's own id is exact, so it cannot pick the wrong row
-- or fail to find one that is plainly there.
--
-- Also: a bar can legitimately have the same article twice on one table (two
-- separate rounds), and article_id could not tell those apart.
-- ===========================================================================

create or replace function pay_part_of_order(
  p_order    uuid,
  p_bill     uuid,
  p_lines    jsonb,          -- [{ line_id, qty }] — line_id preferred, article_id still accepted
  p_method   text,
  p_paid     boolean default true,
  p_discount numeric default 0,
  p_payments jsonb default null,
  p_customer jsonb default null
) returns bills
language plpgsql security definer set search_path = public, extensions as $$
declare
  o orders%rowtype; b bars%rowtype; v_bill bills%rowtype;
  v_line jsonb; v_src order_lines%rowtype; v_take int;
  v_disc numeric(5,2); v_gross numeric(10,2); v_cost numeric(10,2);
  v_total numeric(10,2); v_sum numeric(10,2); v_method text; v_left int;
begin
  select * into v_bill from bills where id = p_bill;
  if found then return v_bill; end if;            -- idempotent replay

  select * into o from orders where id = p_order;
  if not found then raise exception 'unknown_order'; end if;
  if not is_staff_of(o.bar_id) then raise exception 'not_your_bar'; end if;
  if not bar_is_live(o.bar_id) then raise exception 'subscription_inactive'; end if;
  if o.status = 'closed' then raise exception 'order_already_closed'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'nothing_selected'; end if;

  select * into b from bars where id = o.bar_id;

  v_disc := coalesce(p_discount, 0);
  if v_disc < 0 or v_disc > 100 then raise exception 'bad_discount'; end if;
  if jwt_staff_role() <> 'owner' and not b.allow_staff_discount then v_disc := 0; end if;

  insert into bills (id, bar_id, order_id, table_label, method, paid, settled_at,
                     discount, total, cost, staff_id, staff_name,
                     fiscal_status, customer_tax_id, customer_name)
  values (p_bill, o.bar_id, o.id, o.table_label, null, false, null,
          v_disc, 0, 0, o.staff_id, o.staff_name, 'not_required',
          nullif(p_customer->>'taxId', ''), nullif(p_customer->>'name', ''))
  returning * into v_bill;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    -- Exact match first; fall back to article for older clients.
    if v_line ? 'line_id' and nullif(v_line->>'line_id', '') is not null then
      select * into v_src from order_lines
       where id = (v_line->>'line_id')::uuid and order_id = p_order;
    else
      select * into v_src from order_lines
       where order_id = p_order and article_id = (v_line->>'article_id')::uuid
       limit 1;
    end if;

    if not found then raise exception 'line_not_on_this_table'; end if;

    v_take := greatest(1, (v_line->>'qty')::int);
    if v_take > v_src.qty then raise exception 'more_than_is_on_the_table'; end if;

    insert into bill_lines (bill_id, article_id, name, category, qty,
                            unit_price, unit_cost, vat_rate)
    values (p_bill, v_src.article_id, v_src.name, v_src.category, v_take,
            v_src.unit_price, v_src.unit_cost, v_src.vat_rate);

    if v_take = v_src.qty then
      delete from order_lines where id = v_src.id;
    else
      update order_lines set qty = qty - v_take where id = v_src.id;
    end if;
  end loop;

  select coalesce(sum(unit_price * qty), 0), coalesce(sum(unit_cost * qty), 0)
    into v_gross, v_cost from bill_lines where bill_id = p_bill;

  v_total := round(v_gross * (1 - v_disc / 100), 2);

  if p_paid then
    if p_payments is not null and jsonb_array_length(p_payments) > 0 then
      if exists (select 1 from jsonb_array_elements(p_payments) e
                 where e->>'method' not in ('cash','card')) then raise exception 'bad_method'; end if;
      select round(sum((e->>'amount')::numeric), 2) into v_sum
        from jsonb_array_elements(p_payments) e;
      if abs(v_sum - v_total) > 0.01 then raise exception 'payments_do_not_match_total'; end if;
      select e->>'method' into v_method from jsonb_array_elements(p_payments) e
       order by (e->>'amount')::numeric desc limit 1;
    else
      if p_method not in ('cash','card') then raise exception 'bad_method'; end if;
      v_method := p_method;
    end if;
  end if;

  update bills
     set total = v_total, cost = v_cost, method = v_method, paid = p_paid,
         settled_at = case when p_paid then now() end,
         payments = case when p_paid then p_payments end,
         vat_breakdown = bill_vat_breakdown(p_bill, v_disc),
         fiscal_status = case when b.fiscal_enabled and p_paid then 'pending' else 'not_required' end
   where id = p_bill
  returning * into v_bill;

  select count(*) into v_left from order_lines where order_id = p_order;
  if v_left = 0 then
    update orders set status = 'closed', closed_at = now() where id = p_order;
  end if;

  return v_bill;
end $$;

notify pgrst, 'reload schema';
