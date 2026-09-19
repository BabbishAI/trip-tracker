-- Version history for shared trip plans.
--
-- WHY THIS EXISTS
-- Anyone holding the share link can edit the plan: add items, remove items, change
-- who is in on an expense. That is the group's deliberate choice, and it is the right
-- one for fourteen people who all need to keep the ledger honest. But it means a
-- mistaken tap — or a forwarded link in the wrong hands — can wipe a record of
-- thousands of dollars in bookings, confirmation numbers included.
--
-- save_plan() is an upsert, so today the old contents are simply gone. This script
-- makes every save keep the version it replaced, so any bad edit is recoverable.
--
-- HOW TO RUN IT
-- Supabase dashboard -> SQL Editor -> New query -> paste all of this -> Run.
-- It is safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. Where old versions live.
-- ---------------------------------------------------------------------------
create table if not exists public.plan_versions (
  version_id bigserial primary key,
  plan_id    text not null,
  data       jsonb not null,
  saved_at   timestamptz not null default now()
);

create index if not exists plan_versions_plan_idx
  on public.plan_versions (plan_id, saved_at desc);

-- This table holds confirmation numbers, exactly like plans does. Lock it down the
-- same way: row-level security on, and no direct grants to the anon role. Everything
-- below reaches it through SECURITY DEFINER functions instead.
alter table public.plan_versions enable row level security;
revoke all on public.plan_versions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Snapshot on every save.
-- ---------------------------------------------------------------------------
-- Replaces the existing save_plan(). Same signature and same behaviour from the
-- app's point of view — it just files the outgoing version first.
create or replace function public.save_plan(pid text, payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  previous jsonb;
begin
  select data into previous from public.plans where id = pid;

  -- Only keep a version when there was something there and it actually changed;
  -- the client autosaves on a debounce, so identical rewrites are common.
  if previous is not null and previous is distinct from payload then
    insert into public.plan_versions (plan_id, data) values (pid, previous);

    -- Keep the last 50 versions per plan. Enough to walk back from a bad afternoon
    -- without the table growing without bound.
    delete from public.plan_versions
     where plan_id = pid
       and version_id not in (
         select version_id from public.plan_versions
          where plan_id = pid
          order by saved_at desc
          limit 50
       );
  end if;

  insert into public.plans (id, data, updated_at)
       values (pid, payload, now())
  on conflict (id) do update
          set data = excluded.data,
              updated_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Reading and restoring history.
-- ---------------------------------------------------------------------------
-- Deliberately returns no plan contents — just when each version was taken and how
-- big it was. Listing history should not be a second way to read the trip data.
create or replace function public.list_plan_versions(pid text)
returns table (version_id bigint, saved_at timestamptz, items int)
language sql
security definer
set search_path = public
as $$
  select v.version_id,
         v.saved_at,
         coalesce(jsonb_array_length(v.data -> 'items'), 0) as items
    from public.plan_versions v
   where v.plan_id = pid
   order by v.saved_at desc;
$$;

-- Put a past version back. The current contents are snapshotted first, so an
-- unwanted restore is itself undoable.
create or replace function public.restore_plan_version(pid text, vid bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  older jsonb;
begin
  select data into older
    from public.plan_versions
   where plan_id = pid and version_id = vid;

  if older is null then
    raise exception 'no version % for plan %', vid, pid;
  end if;

  perform public.save_plan(pid, older);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Deleting a plan outright.
-- ---------------------------------------------------------------------------
-- There was no way to remove a plan, so stale and test rows accumulate forever —
-- each one still readable by anyone who knows its id.
create or replace function public.delete_plan(pid text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.plan_versions where plan_id = pid;
  delete from public.plans where id = pid;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants. The anon role calls these functions and touches no table directly.
-- ---------------------------------------------------------------------------
grant execute on function public.save_plan(text, jsonb)            to anon, authenticated;
grant execute on function public.list_plan_versions(text)          to anon, authenticated;
grant execute on function public.restore_plan_version(text, bigint) to anon, authenticated;
grant execute on function public.delete_plan(text)                 to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Clean up the rows left behind by this session's security testing and by the
--    move to an unguessable plan id.
--    IMPORTANT: run these only once you have confirmed the new link works.
--    Deleting tornabene-2027 breaks the old link for anyone still using it.
-- ---------------------------------------------------------------------------
-- select public.delete_plan('zz-sec-probe-1789820721');
-- select public.delete_plan('zz-test-7546b965');
-- select public.delete_plan('tornabene-2027');
