-- Shelf's own table. Better Auth tables are created by `npm run db:migrate`
-- through better-auth's own migration generator.
create table if not exists shelf_files (
  user_id text not null,
  id text not null,
  machine_id text not null,
  path_on_machine text not null,
  html text not null,
  sha256 text not null default '',
  created_at timestamptz not null default now(),
  edited_at timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, machine_id, path_on_machine)
);

alter table shelf_files add column if not exists sha256 text not null default '';

create index if not exists shelf_files_user_created_idx
  on shelf_files (user_id, created_at desc);

create index if not exists shelf_files_user_edited_idx
  on shelf_files (user_id, edited_at);

create index if not exists shelf_files_user_machine_idx
  on shelf_files (user_id, machine_id);
