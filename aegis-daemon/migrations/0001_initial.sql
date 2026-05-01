create table if not exists projects(
  id text primary key,
  name text not null,
  root_path text not null,
  preferred_ide text,
  created_at text not null,
  last_opened_at text
);

create table if not exists sessions(
  id text primary key,
  project_id text not null,
  title text,
  model_id text,
  started_at text not null,
  finished_at text,
  status text not null
);

create table if not exists turns(
  id text primary key,
  session_id text not null,
  user_message text not null,
  prompt_fingerprint text not null,
  started_at text not null,
  finished_at text,
  status text not null
);

create table if not exists tool_calls(
  id text primary key,
  turn_id text not null,
  tool_name text not null,
  args_json text not null,
  approved integer not null default 0,
  started_at text,
  finished_at text,
  status text not null,
  result_summary text,
  raw_result_path text
);

create table if not exists proposals(
  id text primary key,
  turn_id text not null,
  summary text,
  patch text not null,
  status text not null,
  created_at text not null
);

create table if not exists review_events(
  id text primary key,
  proposal_id text not null,
  kind text not null,
  file_path text,
  line integer,
  hunk_id text,
  body text,
  created_at text not null
);

create table if not exists index_chunks(
  id text primary key,
  project_id text not null,
  file_path text not null,
  line_start integer,
  line_end integer,
  content_hash text not null,
  symbol_name text,
  indexed_at text not null
);
