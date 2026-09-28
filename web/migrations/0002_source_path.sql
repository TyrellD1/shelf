-- Where a file was written from on the machine that wrote it. Metadata only:
-- it is never part of the id, and clients must treat it as a hint that can be
-- missing. Old rows get null, which every reader already handles.
alter table shelf_files add column if not exists source_path text;
