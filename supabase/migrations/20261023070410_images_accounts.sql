-- Images, board titles and previews, and optional accounts with saved boards.
--
-- Boards stay public to anyone with the link and work without an account. An account only
-- adds a personal list of boards ("Your boards") that follows you across devices.

-- ------------------------------------------------------------------ images
-- A public bucket. Uploads only land in the folder of a board that exists, images only,
-- 2 MB each, at most 200 per board.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lattice-images', 'lattice-images', true, 2097152, array['image/webp', 'image/png', 'image/jpeg', 'image/gif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Runs as its owner so the upload policy can look at the private lattice schema and the
-- bucket's existing objects without granting browsers access to either.
create or replace function public.lattice_can_upload(p_name text)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_folder text := split_part(p_name, '/', 1);
  v_board uuid;
begin
  if p_name !~ '^[0-9a-f-]{36}/[A-Za-z0-9_-]{6,64}\.(webp|png|jpe?g|gif)$' or split_part(p_name, '/', 3) <> '' then
    return false;
  end if;
  v_board := v_folder::uuid;
  if not exists (select 1 from lattice.boards b where b.id = v_board) then
    return false;
  end if;
  return (select count(*) from storage.objects o where o.bucket_id = 'lattice-images' and o.name like v_folder || '/%') < 200;
exception when invalid_text_representation then
  return false;
end $$;

revoke all on function public.lattice_can_upload(text) from public;
grant execute on function public.lattice_can_upload(text) to anon, authenticated;

create policy "lattice images: upload into an existing board"
  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'lattice-images' and public.lattice_can_upload(name));

-- ------------------------------------------------------------------ previews and titles
alter table lattice.boards add column if not exists preview text
  check (preview is null or (octet_length(preview) <= 60000 and preview like '<svg%'));
alter table lattice.boards add column if not exists preview_at timestamptz;

-- ------------------------------------------------------------------ saved boards
create table if not exists lattice.user_boards (
  user_id uuid not null references auth.users(id) on delete cascade,
  board_id uuid not null references lattice.boards(id) on delete cascade,
  added_at timestamptz not null default now(),
  opened_at timestamptz not null default now(),
  primary key (user_id, board_id)
);
create index if not exists user_boards_recent on lattice.user_boards (user_id, opened_at desc);
alter table lattice.user_boards enable row level security;
revoke all on lattice.user_boards from public, anon, authenticated;

-- sign-up rate limiting (rows written only by the lattice-signup edge function)
create table if not exists lattice.signups (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists signups_ip_time on lattice.signups (ip_hash, created_at desc);
alter table lattice.signups enable row level security;
revoke all on lattice.signups from public, anon, authenticated;

-- ------------------------------------------------------------------ API

-- Anyone with the link can edit the board, so anyone with the link can rename it.
create or replace function public.lattice_rename_board(p_board uuid, p_title text)
returns text
language plpgsql security definer set search_path = '' as $$
declare v_title text := left(trim(coalesce(p_title, '')), 80);
begin
  if v_title = '' then raise exception 'A board needs a name' using errcode = '22023'; end if;
  update lattice.boards set title = v_title, last_active_at = now() where id = p_board;
  if not found then raise exception 'Board not found' using errcode = 'P0002'; end if;
  return v_title;
end $$;

-- A small SVG thumbnail of the board, drawn by a client. Shown through <img>, which never
-- runs scripts inside an SVG, but obvious script is refused anyway.
create or replace function public.lattice_set_preview(p_board uuid, p_svg text)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_svg is null or octet_length(p_svg) > 60000 or p_svg not like '<svg%' then
    raise exception 'Not a preview' using errcode = '22023';
  end if;
  if p_svg ~* '(<script|javascript:|on[a-z]+\s*=|<foreignobject)' then
    raise exception 'Not a preview' using errcode = '22023';
  end if;
  update lattice.boards set preview = p_svg, preview_at = now()
  where id = p_board and (preview_at is null or preview_at < now() - interval '5 seconds');
  return found;
end $$;

-- Remember a board in the signed-in user's list (called when they open or create one).
create or replace function public.lattice_save_board(p_board uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Sign in to save boards' using errcode = '42501'; end if;
  if not exists (select 1 from lattice.boards where id = p_board) then return false; end if;
  if (select count(*) from lattice.user_boards where user_id = v_user) >= 500 then
    raise exception 'You have saved the maximum number of boards' using errcode = 'P0001';
  end if;
  insert into lattice.user_boards (user_id, board_id) values (v_user, p_board)
  on conflict (user_id, board_id) do update set opened_at = now();
  return true;
end $$;

create or replace function public.lattice_forget_board(p_board uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  delete from lattice.user_boards where user_id = auth.uid() and board_id = p_board;
  return found;
end $$;

-- The signed-in user's boards, most recently opened first.
create or replace function public.lattice_my_boards()
returns table (id uuid, title text, created_at timestamptz, opened_at timestamptz, last_active_at timestamptz, preview text, op_count bigint)
language sql stable security definer set search_path = '' as $$
  select b.id, b.title, b.created_at, ub.opened_at, b.last_active_at, b.preview,
         (select count(*) from lattice.ops o where o.board_id = b.id)
  from lattice.user_boards ub join lattice.boards b on b.id = ub.board_id
  where ub.user_id = auth.uid()
  order by ub.opened_at desc
  limit 200
$$;

-- Public details for a list of boards (for boards remembered on this device only).
create or replace function public.lattice_boards_info(p_ids uuid[])
returns table (id uuid, title text, created_at timestamptz, last_active_at timestamptz, preview text)
language sql stable security definer set search_path = '' as $$
  select b.id, b.title, b.created_at, b.last_active_at, b.preview
  from lattice.boards b where b.id = any(p_ids[1:100])
$$;

revoke all on function public.lattice_rename_board(uuid, text) from public;
revoke all on function public.lattice_set_preview(uuid, text) from public;
revoke all on function public.lattice_save_board(uuid) from public;
revoke all on function public.lattice_forget_board(uuid) from public;
revoke all on function public.lattice_my_boards() from public;
revoke all on function public.lattice_boards_info(uuid[]) from public;
grant execute on function public.lattice_rename_board(uuid, text) to anon, authenticated;
grant execute on function public.lattice_set_preview(uuid, text) to anon, authenticated;
grant execute on function public.lattice_boards_info(uuid[]) to anon, authenticated;
grant execute on function public.lattice_save_board(uuid) to authenticated;
grant execute on function public.lattice_forget_board(uuid) to authenticated;
grant execute on function public.lattice_my_boards() to authenticated;
