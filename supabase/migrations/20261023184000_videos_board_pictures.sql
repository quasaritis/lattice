-- Videos on boards, and a full picture of every board (drawings included) kept in Storage.

-- Videos: their own bucket, because a video needs a far bigger size limit than a photo.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lattice-videos', 'lattice-videos', true, 52428800, array['video/mp4', 'video/webm', 'video/quicktime'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.lattice_can_upload_video(p_name text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_folder text := split_part(p_name, '/', 1);
  v_board uuid;
begin
  if p_name !~ '^[0-9a-f-]{36}/[A-Za-z0-9_-]{6,64}\.(mp4|webm|mov)$' or split_part(p_name, '/', 3) <> '' then
    return false;
  end if;
  v_board := v_folder::uuid;
  if not exists (select 1 from lattice.boards b where b.id = v_board) then
    return false;
  end if;
  -- up to 20 videos per board
  return (select count(*) from storage.objects o where o.bucket_id = 'lattice-videos' and o.name like v_folder || '/%') < 20;
exception when invalid_text_representation then
  return false;
end $$;

drop policy if exists "lattice videos: upload into an existing board" on storage.objects;
create policy "lattice videos: upload into an existing board" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'lattice-videos' and public.lattice_can_upload_video(name));

-- Board pictures: an SVG of the whole board, drawn by the lattice-index edge function.
-- Only the server writes here (service role); the files are readable by board id like the board itself.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lattice-boards', 'lattice-boards', true, 10485760, array['image/svg+xml'])
on conflict (id) do nothing;

-- Keep the stroke data next to each item, so drawings are in the table too.
alter table lattice.board_items add column if not exists stroke text;

alter table lattice.boards add column if not exists picture_url text;

drop view if exists lattice.board_overview;
create view lattice.board_overview with (security_invoker = true) as
select
  b.id,
  coalesce(nullif(b.title, ''), 'Untitled board') as title,
  'https://quasarboard.vercel.app/b/' || b.id as link,
  b.picture_url as picture,
  b.created_at,
  b.last_active_at,
  b.item_count as items,
  count(*) filter (where i.kind = 'note')                    as notes,
  count(*) filter (where i.kind = 'text')                    as texts,
  count(*) filter (where i.kind in ('ink', 'arrow'))         as drawings,
  count(*) filter (where i.kind in ('rect', 'ellipse'))      as shapes,
  count(*) filter (where i.kind = 'image')                   as images,
  count(*) filter (where i.kind = 'video')                   as videos,
  (select count(*) from lattice.user_boards ub where ub.board_id = b.id) as saved_by_accounts,
  (select count(*) from lattice.ops o where o.board_id = b.id) as edits,
  left(string_agg(nullif(i.text, ''), ' · ' order by i.z nulls last), 2000) as all_text,
  b.indexed_at
from lattice.boards b
left join lattice.board_items i on i.board_id = b.id
group by b.id;

comment on view lattice.board_overview is 'One row per board: a picture of it, what it holds and all its text.';

-- Every photo and video ever uploaded, still on a board or not.
create or replace view lattice.board_uploads with (security_invoker = true) as
select
  split_part(o.name, '/', 1)::uuid as board_id,
  coalesce(nullif(b.title, ''), 'Untitled board') as board_title,
  case when o.bucket_id = 'lattice-videos' then 'video' else 'image' end as type,
  'https://mftkwebfvmmtyqfkizcq.supabase.co/storage/v1/object/public/' || o.bucket_id || '/' || o.name as url,
  (o.metadata ->> 'size')::bigint as bytes,
  o.metadata ->> 'mimetype' as mime,
  exists (
    select 1 from lattice.board_items i
    where i.board_id = split_part(o.name, '/', 1)::uuid and i.image_url like '%/' || o.bucket_id || '/' || o.name
  ) as on_board,
  o.created_at as uploaded_at
from storage.objects o
left join lattice.boards b on b.id::text = split_part(o.name, '/', 1)
where o.bucket_id in ('lattice-images', 'lattice-videos') and o.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/';

comment on view lattice.board_uploads is 'Every photo and video people uploaded, with a link, and whether it is still on its board.';

drop view if exists lattice.board_images;
create view lattice.board_images with (security_invoker = true) as
select
  i.board_id,
  coalesce(nullif(b.title, ''), 'Untitled board') as board_title,
  i.kind as type,
  i.image_url as url,
  round(i.w) as width, round(i.h) as height, i.rotation,
  (o.metadata ->> 'size')::bigint as bytes,
  o.created_at as uploaded_at
from lattice.board_items i
join lattice.boards b on b.id = i.board_id
left join storage.objects o
  on o.bucket_id in ('lattice-images', 'lattice-videos')
 and o.name = substring(i.image_url from '/lattice-(?:images|videos)/(.*)$')
where i.kind in ('image', 'video');

comment on view lattice.board_images is 'Every photo and video currently on a board, with its link, size and rotation.';

revoke all on lattice.board_overview, lattice.board_images, lattice.board_uploads from anon, authenticated;
