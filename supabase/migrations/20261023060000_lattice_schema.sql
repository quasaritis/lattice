-- Lattice: persistence for a CRDT whiteboard.
--
-- The server never merges anything. It is an append-only, de-duplicated op log plus an
-- optional snapshot per board. All conflict resolution happens in the clients, which is
-- the point of CRDTs: the server only needs to be a reliable mailbox.
--
-- Tables live in a private `lattice` schema that the REST API does not expose. Browsers
-- reach them only through the `public.lattice_*` functions below, which validate input
-- and enforce size and rate limits.

create schema if not exists lattice;
revoke all on schema lattice from public, anon, authenticated;

create table lattice.boards (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Untitled board' check (char_length(title) between 1 and 80),
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);
create index boards_created on lattice.boards (created_at desc);

-- One row per CRDT op. op_id is the op's hybrid-logical-clock timestamp, unique per board,
-- so a retried upload can never create a duplicate.
create table lattice.ops (
  seq bigint generated always as identity primary key,
  board_id uuid not null references lattice.boards(id) on delete cascade,
  op_id text not null check (op_id ~ '^\d{13}\.[0-9a-z]{5}\.[A-Za-z0-9_-]{1,32}$'),
  op jsonb not null check (jsonb_typeof(op) = 'object' and octet_length(op::text) <= 12000),
  created_at timestamptz not null default now(),
  unique (board_id, op_id)
);
create index ops_board_seq on lattice.ops (board_id, seq);
create index ops_board_time on lattice.ops (board_id, created_at);

-- Latest state snapshot per board (a CvRDT state: joining it with later ops is always safe).
create table lattice.snapshots (
  board_id uuid primary key references lattice.boards(id) on delete cascade,
  upto_seq bigint not null,
  state jsonb not null check (octet_length(state::text) <= 2000000),
  updated_at timestamptz not null default now()
);

alter table lattice.boards enable row level security;
alter table lattice.ops enable row level security;
alter table lattice.snapshots enable row level security;
revoke all on all tables in schema lattice from public, anon, authenticated;

-- ------------------------------------------------------------------ API

create or replace function public.lattice_create_board(p_title text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if (select count(*) from lattice.boards where created_at > now() - interval '1 hour') >= 300 then
    raise exception 'Too many new boards right now. Try again in a few minutes.' using errcode = 'P0001';
  end if;
  insert into lattice.boards (title)
  values (coalesce(nullif(left(trim(coalesce(p_title, '')), 80), ''), 'Untitled board'))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.lattice_board(p_board uuid)
returns table (id uuid, title text, created_at timestamptz, op_count bigint)
language sql stable security definer set search_path = '' as $$
  select b.id, b.title, b.created_at,
         (select count(*) from lattice.ops o where o.board_id = b.id)
  from lattice.boards b where b.id = p_board
$$;

-- Append ops. Duplicates are ignored. Returns the board's latest seq.
create or replace function public.lattice_push(p_board uuid, p_ops jsonb)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_last bigint;
begin
  if jsonb_typeof(p_ops) <> 'array' or jsonb_array_length(p_ops) = 0 or jsonb_array_length(p_ops) > 300 then
    raise exception 'Send between 1 and 300 ops at a time' using errcode = '22023';
  end if;
  if not exists (select 1 from lattice.boards where id = p_board) then
    raise exception 'Board not found' using errcode = 'P0002';
  end if;
  if (select count(*) from lattice.ops where board_id = p_board and created_at > now() - interval '1 minute') >= 6000 then
    raise exception 'This board is receiving too many edits. Slow down a little.' using errcode = 'P0001';
  end if;
  if (select count(*) from lattice.ops where board_id = p_board) >= 100000 then
    raise exception 'This board is full' using errcode = 'P0001';
  end if;

  insert into lattice.ops (board_id, op_id, op)
  select p_board, e->>'id', e
  from jsonb_array_elements(p_ops) e
  where jsonb_typeof(e) = 'object' and e->>'id' is not null
  order by e->>'id'
  on conflict (board_id, op_id) do nothing;

  update lattice.boards set last_active_at = now() where id = p_board;
  select coalesce(max(seq), 0) into v_last from lattice.ops where board_id = p_board;
  return v_last;
end $$;

-- Ops after a given seq, oldest first. Clients page through with p_after.
create or replace function public.lattice_pull(p_board uuid, p_after bigint default 0, p_limit int default 2000)
returns table (seq bigint, op jsonb)
language sql stable security definer set search_path = '' as $$
  select o.seq, o.op from lattice.ops o
  where o.board_id = p_board and o.seq > coalesce(p_after, 0)
  order by o.seq
  limit least(greatest(coalesce(p_limit, 2000), 1), 5000)
$$;

create or replace function public.lattice_get_snapshot(p_board uuid)
returns table (upto_seq bigint, state jsonb)
language sql stable security definer set search_path = '' as $$
  select s.upto_seq, s.state from lattice.snapshots s where s.board_id = p_board
$$;

-- Store a snapshot covering ops up to p_upto. Only ever moves forward.
create or replace function public.lattice_put_snapshot(p_board uuid, p_upto bigint, p_state jsonb)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_max bigint;
begin
  if jsonb_typeof(p_state) <> 'object' or not (p_state ? 'items' and p_state ? 'props' and p_state ? 'texts') then
    raise exception 'Not a board state' using errcode = '22023';
  end if;
  select coalesce(max(seq), 0) into v_max from lattice.ops where board_id = p_board;
  if p_upto > v_max or p_upto < 1 then return false; end if;
  insert into lattice.snapshots as s (board_id, upto_seq, state) values (p_board, p_upto, p_state)
  on conflict (board_id) do update set upto_seq = excluded.upto_seq, state = excluded.state, updated_at = now()
  where s.upto_seq < excluded.upto_seq;
  return found;
end $$;

-- Only these functions are callable from the browser.
revoke all on function public.lattice_create_board(text) from public;
revoke all on function public.lattice_board(uuid) from public;
revoke all on function public.lattice_push(uuid, jsonb) from public;
revoke all on function public.lattice_pull(uuid, bigint, int) from public;
revoke all on function public.lattice_get_snapshot(uuid) from public;
revoke all on function public.lattice_put_snapshot(uuid, bigint, jsonb) from public;
grant execute on function public.lattice_create_board(text) to anon, authenticated;
grant execute on function public.lattice_board(uuid) to anon, authenticated;
grant execute on function public.lattice_push(uuid, jsonb) to anon, authenticated;
grant execute on function public.lattice_pull(uuid, bigint, int) to anon, authenticated;
grant execute on function public.lattice_get_snapshot(uuid) to anon, authenticated;
grant execute on function public.lattice_put_snapshot(uuid, bigint, jsonb) to anon, authenticated;
