-- Optional reference schema for LeaseQ local-workspace sync.
-- Run only in a Supabase project you control. This does not provision a project.
create table if not exists public.leaseq_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision integer not null check (revision >= 1),
  data jsonb not null default '{}'::jsonb check (octet_length(data::text) <= 16000),
  deleted_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.leaseq_workspaces enable row level security;
revoke all on public.leaseq_workspaces from public, anon, authenticated;
grant select, insert, update on public.leaseq_workspaces to authenticated;

drop policy if exists leaseq_workspace_select_own on public.leaseq_workspaces;
create policy leaseq_workspace_select_own on public.leaseq_workspaces
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists leaseq_workspace_insert_own on public.leaseq_workspaces;
create policy leaseq_workspace_insert_own on public.leaseq_workspaces
  for insert to authenticated with check (auth.uid() = user_id and revision = 1);
drop policy if exists leaseq_workspace_update_own on public.leaseq_workspaces;
create policy leaseq_workspace_update_own on public.leaseq_workspaces
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.leaseq_workspace_guard_update()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if new.user_id <> old.user_id or new.revision <> old.revision + 1 then
    raise exception 'workspace identity is immutable and revision must increment by one';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists leaseq_workspace_guard_update on public.leaseq_workspaces;
create trigger leaseq_workspace_guard_update before update on public.leaseq_workspaces
  for each row execute function public.leaseq_workspace_guard_update();
