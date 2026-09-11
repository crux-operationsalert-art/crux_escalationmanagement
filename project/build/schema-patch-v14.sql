-- =====================================================================
-- CRUX — schema patch v14
-- A reference allocator that cannot be broken by a neighbouring row.
--
-- Both reference generators read every existing ref and assume it is the
-- prefix plus digits:
--
--   select 'ESC-' || lpad((coalesce(max(substring(ref from 5)::int),0)+1)...
--
-- One sample row shaped SMP-ESC-0001 makes substring() return "ESC-0001",
-- the cast fails, and raising an escalation stops working entirely with
-- "invalid input syntax for type integer". The same pattern is in the RSE
-- generator for raisables.
--
-- max()+1 is also a race. Two people raising in the same instant both read
-- the same maximum, both compute the same next number, and one of them
-- loses to the unique index — at the moment they were trying to record
-- something that mattered.
--
-- A counter row fixes both: the UPDATE takes a row lock, so the numbers are
-- handed out one at a time, and nothing outside the counter is read.
-- Run after schema-patch-v13.sql.
-- =====================================================================

create table if not exists ref_counter (
  prefix  text primary key,
  last_no bigint not null default 0
);
comment on table ref_counter is
  'One row per reference prefix. next_ref() increments under a row lock, so two '
  'people raising at the same moment cannot be handed the same reference, and a '
  'differently-shaped ref elsewhere in the table cannot break the sequence.';

alter table ref_counter enable row level security;
alter table ref_counter force row level security;
revoke all on ref_counter from anon, authenticated;

create or replace function next_ref(p_prefix text, p_width int default 5)
returns text language plpgsql set search_path = public as $fn$
declare v bigint;
begin
  insert into ref_counter (prefix, last_no) values (p_prefix, 0)
    on conflict (prefix) do nothing;
  update ref_counter set last_no = last_no + 1
   where prefix = p_prefix returning last_no into v;
  return p_prefix || '-' || lpad(v::text, p_width, '0');
end $fn$;

-- Carry on from the highest well-formed number already in use, ignoring rows
-- that were never in that shape.
insert into ref_counter (prefix, last_no)
select 'ESC', coalesce(max(substring(ref from 5)::bigint), 0)
  from "case" where ref ~ '^ESC-[0-9]+$'
on conflict (prefix) do update set last_no = greatest(ref_counter.last_no, excluded.last_no);

insert into ref_counter (prefix, last_no)
select 'RSE', coalesce(max(substring(ref from 5)::bigint), 0)
  from raisable where ref ~ '^RSE-[0-9]+$'
on conflict (prefix) do update set last_no = greatest(ref_counter.last_no, excluded.last_no);

insert into ref_counter (prefix, last_no)
select 'OGL', coalesce(max(substring(ref from 5)::bigint), 0)
  from assignment where ref ~ '^OGL-[0-9]+$'
on conflict (prefix) do update set last_no = greatest(ref_counter.last_no, excluded.last_no);

revoke all on function next_ref(text,int) from public, anon, authenticated;
grant execute on function next_ref(text,int) to service_role;
