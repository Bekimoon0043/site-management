-- Client / owner representative: a read-only external portal role.
-- Keep this migration enum-only: PostgreSQL cannot use a newly-added enum
-- value until the transaction that adds it has committed.
alter type public.app_role add value if not exists 'client';
