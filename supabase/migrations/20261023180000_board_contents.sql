-- A readable copy of what is on every board, rebuilt on the server by replaying the op log
-- with the same CRDT code the browsers run (edge function lattice-index). Nothing here is
-- written by browsers, and none of it is reachable through the public API.

alter table lattice.boards
  add column if not exists item_count integer not null default 0,
  add column if not exists indexed_seq bigint not null default 0,
  add column if not exists indexed_at timestamptz;

create table if not exists lattice.board_items (
  board_id   uuid not null references lattice.boards(id) on delete cascade,
  item_id    text not null,
  kind       text not null,
  text       text not null default '',
  color      text,
  brush      text,
  font_size  real,
  x real, y real, w real, h real,
  rotation   real not null default 0,
  z          real,
  image_url  text,
  points     integer,
  updated_at timestamptz not null default now(),
  primary key (board_id, item_id)
);
create index if not exists board_items_kind on lattice.board_items (kind);
alter table lattice.board_items enable row level security;
revoke all on lattice.board_items from anon, authenticated;

comment on table lattice.board_items is 'Everything currently on each board, one row per item. Rebuilt from the op log by the lattice-index edge function.';

create or replace view lattice.board_overview with (security_invoker = true) as
select
  b.id,
  coalesce(nullif(b.title, ''), 'Untitled board') as title,
  'https://quasarboard.vercel.app/b/' || b.id as link,
  b.created_at,
  b.last_active_at,
  b.item_count as items,
  count(*) filter (where i.kind = 'note')                    as notes,
  count(*) filter (where i.kind = 'text')                    as texts,
  count(*) filter (where i.kind in ('ink', 'arrow'))         as drawings,
  count(*) filter (where i.kind in ('rect', 'ellipse'))      as shapes,
  count(*) filter (where i.kind = 'image')                   as images,
  (select count(*) from lattice.user_boards ub where ub.board_id = b.id) as saved_by_accounts,
  (select count(*) from lattice.ops o where o.board_id = b.id) as edits,
  left(string_agg(nullif(i.text, ''), ' · ' order by i.z nulls last), 2000) as all_text,
  b.indexed_at
from lattice.boards b
left join lattice.board_items i on i.board_id = b.id
group by b.id;

comment on view lattice.board_overview is 'One row per board: what it holds and all its text. Newest activity first when sorted by last_active_at.';

create or replace view lattice.board_images with (security_invoker = true) as
select
  i.board_id,
  coalesce(nullif(b.title, ''), 'Untitled board') as board_title,
  i.image_url,
  round(i.w) as width, round(i.h) as height, i.rotation,
  (o.metadata ->> 'size')::bigint as bytes,
  o.created_at as uploaded_at
from lattice.board_items i
join lattice.boards b on b.id = i.board_id
left join storage.objects o
  on o.bucket_id = 'lattice-images'
 and o.name = substring(i.image_url from '/lattice-images/(.*)$')
where i.kind = 'image';

comment on view lattice.board_images is 'Every picture that is currently on a board, with its public link.';

revoke all on lattice.board_overview, lattice.board_images from anon, authenticated;
