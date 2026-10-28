-- RETIRED 2026-10-27. Kept for reference only.
--
-- The backend is no longer Supabase. It is a Google Apps Script web app in front of a
-- private Google Sheet: see apps-script/Code.gs and apps-script/SETUP.md. This file
-- describes the database that was lost three times and is not part of the live system.
--
-- It is still here because tools/rescue-from-supabase.sh can pull the trip out of that
-- project if it is ever restored, and because the shape of the access model carried
-- over: exact-id reads, no listing, snapshot before overwrite.

-- Rebuild the trip-tracker backend from nothing.
--
-- WHY THIS EXISTS
-- The backend has now died three times: the first Supabase project was deleted by
-- free-tier cleanup in August 2026, the second was paused on 2026-09-30, and it went
-- unreachable again around 2026-10-08 while the keep-alive was still pinging it
-- successfully. Each time, the schema was rebuilt BY HAND from memory, because the
-- only thing the repo held was the version-history add-on. That is the gap this file
-- closes: the base schema the whole site depends on is now a file, not a recollection.
--
-- HOW TO RUN IT
--   1. Supabase dashboard -> SQL Editor -> New query -> paste all of this -> Run.
--   2. Then do the same with sql/version-history.sql (it replaces save_plan() with a
--      version that snapshots each outgoing copy, and adds the history functions).
--   3. If the project is NEW, its URL and anon key differ from the old one. Put them
--      in config.js and bump the ?v= cache-buster on the config.js script tags in
--      index.html and edit.html, or browsers will keep calling the dead backend.
--   4. Reload the data:  bash tools/restore-plan.sh <plan-id> <backup file>
--
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. The one table. A plan is a whole trip as a single JSON document.
-- ---------------------------------------------------------------------------
create table if not exists public.plans (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- The plan id IS the password: it is the only thing standing between a stranger and
-- the group's airline record locators. So the table itself is unreachable for the
-- anon role — no select, no insert, no update. Every path in goes through the
-- SECURITY DEFINER functions below, which only ever answer about one exact id.
--
-- This is what makes enumeration impossible: a listing query returns
-- "permission denied for table plans", and a wrong id returns null.
alter table public.plans enable row level security;
revoke all on public.plans from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Reading one plan.
-- ---------------------------------------------------------------------------
-- Takes an exact id and returns that plan's document, or null. There is deliberately
-- no "list plans", no prefix search and no wildcard — knowing an id is the whole of
-- the authorisation model, so a caller must already have it.
create or replace function public.get_plan(pid text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select p.data from public.plans p where p.id = pid;
$$;

-- ---------------------------------------------------------------------------
-- 3. Writing one plan.
-- ---------------------------------------------------------------------------
-- NOTE: this is the plain upsert, with no version history. sql/version-history.sql
-- replaces it with an identical signature that files the outgoing copy first. Run
-- that file too — this definition exists only so a fresh project is usable if the
-- rebuild is interrupted half way.
--
-- There is no write authentication, by the group's explicit decision: anyone holding
-- the link can edit, because fourteen people all need to keep the ledger honest.
-- The consequence, which is understood and accepted: anyone who knows a plan id can
-- overwrite that plan. The version history and tools/backup-plan.sh are the net.
create or replace function public.save_plan(pid text, payload jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.plans (id, data, updated_at)
       values (pid, payload, now())
  on conflict (id) do update
          set data = excluded.data,
              updated_at = now();
$$;

-- ---------------------------------------------------------------------------
-- 4. Grants. The anon role may call the functions and touch no table directly.
-- ---------------------------------------------------------------------------
grant execute on function public.get_plan(text)         to anon, authenticated;
grant execute on function public.save_plan(text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Check it came up right. Both of these should succeed:
--      select public.save_plan('zz-bootstrap-check', '{"items":[]}'::jsonb);
--      select public.get_plan('zz-bootstrap-check');          -- -> {"items": []}
--    And this should FAIL with "permission denied for table plans" when run as anon
--    from the site (not here in the editor, which runs as the owner):
--      select * from public.plans;
--    Then clean up:
--      delete from public.plans where id = 'zz-bootstrap-check';
-- ---------------------------------------------------------------------------
