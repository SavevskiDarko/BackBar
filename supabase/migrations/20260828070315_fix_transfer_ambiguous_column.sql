-- ===========================================================================
-- FIX: column reference "t.zone_id" is ambiguous, when moving a table
--
-- transfer_order declared a variable called `t` AND aliased the tables table
-- as `t` in the same query. Postgres cannot tell whether `t.zone_id` means the
-- variable's field or the table's column, so it refuses.
--
-- The variable is renamed; nothing else about the function changes.
-- ===========================================================================

create or replace function transfer_order(p_order uuid, p_table uuid)
returns orders language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; v_tbl tables%rowtype; v_label text;
begin
  select * into o from orders where id = p_order;
  if not found then raise exception 'unknown_order'; end if;
  if not is_staff_of(o.bar_id) then raise exception 'not_your_bar'; end if;
  if o.status <> 'open' then raise exception 'order_already_closed'; end if;

  -- Alias `tb`, variable `v_tbl`: no name can mean two things.
  select tb.* into v_tbl
  from tables tb
  join zones z on z.id = tb.zone_id
  where tb.id = p_table and z.bar_id = o.bar_id;

  if not found then raise exception 'unknown_table'; end if;

  -- Two open orders on one table is how bills get mixed up.
  if exists (
    select 1 from orders o2
    where o2.table_id = p_table and o2.status = 'open' and o2.id <> p_order
  ) then
    raise exception 'table_already_open';
  end if;

  v_label := v_tbl.label;

  update orders set table_id = p_table, table_label = v_label
  where id = p_order
  returning * into o;

  insert into audit_log (bar_id, actor, event, subject, detail)
  values (o.bar_id, coalesce(auth.jwt() ->> 'staff_name', 'staff'),
          'table_moved', v_label, jsonb_build_object('orderId', o.id));

  return o;
end $$;

notify pgrst, 'reload schema';
