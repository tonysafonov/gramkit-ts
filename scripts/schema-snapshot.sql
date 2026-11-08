-- Order-independent description of the public schema, for diffing two databases:
--   psql -At -f scripts/schema-snapshot.sql <db> | sort
select 'col ' || table_name || '.' || column_name || ' ' || udt_name
       || coalesce('(' || character_maximum_length || ')', '')
       || case when is_nullable = 'NO' then ' NOT NULL' else '' end
       || coalesce(' DEFAULT ' || column_default, '')
from information_schema.columns
where table_schema = 'public' and table_name not in ('alembic_version', '__drizzle_migrations');

select 'con ' || c.conrelid::regclass || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid)
from pg_constraint c
join pg_namespace n on n.oid = c.connamespace
where n.nspname = 'public' and c.conrelid::regclass::text not in ('alembic_version', '__drizzle_migrations');

select 'idx ' || indexdef
from pg_indexes
where schemaname = 'public' and tablename not in ('alembic_version', '__drizzle_migrations');
