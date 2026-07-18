\pset pager off
\timing on

SELECT clock_timestamp() AS observed_at,
       current_database() AS database_name,
       pg_postmaster_start_time() AS postgres_started_at;

-- Extension availability. Do not CREATE in production from this script.
SELECT extname, extversion
FROM pg_extension
WHERE extname IN ('pg_stat_statements', 'pgstattuple');

-- Current activity and waits.
SELECT backend_type,
       state,
       wait_event_type,
       wait_event,
       count(*) AS sessions,
       max(clock_timestamp() - query_start) FILTER (WHERE state <> 'idle') AS oldest_query
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY backend_type, state, wait_event_type, wait_event
ORDER BY sessions DESC;

-- Top SQL by WAL and time, if pg_stat_statements exists.
SELECT queryid,
       calls,
       round(total_exec_time::numeric, 1) AS total_exec_ms,
       round(mean_exec_time::numeric, 3) AS mean_exec_ms,
       rows,
       wal_records,
       wal_fpi,
       pg_size_pretty(wal_bytes::bigint) AS wal,
       left(regexp_replace(query, '\s+', ' ', 'g'), 180) AS query_sample
FROM pg_stat_statements
ORDER BY wal_bytes DESC NULLS LAST
LIMIT 30;

-- Cluster WAL.
SELECT wal_records,
       wal_fpi,
       pg_size_pretty(wal_bytes::bigint) AS wal_bytes,
       wal_buffers_full,
       wal_write,
       wal_sync,
       wal_write_time,
       wal_sync_time,
       stats_reset
FROM pg_stat_wal;

-- PostgreSQL 16 I/O. Columns vary by minor/version; inspect if this query fails.
SELECT backend_type,
       object,
       context,
       reads,
       read_time,
       writes,
       write_time,
       writebacks,
       writeback_time,
       extends,
       extend_time,
       fsyncs,
       fsync_time,
       stats_reset
FROM pg_stat_io
ORDER BY coalesce(write_time,0) + coalesce(fsync_time,0) DESC NULLS LAST;

-- Largest relations and indexes.
SELECT n.nspname AS schema_name,
       c.relname,
       c.relkind,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       pg_total_relation_size(c.oid) AS total_bytes,
       pg_size_pretty(pg_relation_size(c.oid)) AS heap_size,
       pg_size_pretty(pg_indexes_size(c.oid)) AS index_size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND c.relkind IN ('r','m','p')
ORDER BY total_bytes DESC
LIMIT 50;

-- Table churn, vacuum, and XID safety.
SELECT schemaname,
       relname,
       n_live_tup,
       n_dead_tup,
       CASE WHEN n_live_tup > 0
            THEN round(100.0 * n_dead_tup / n_live_tup, 2)
            ELSE NULL END AS dead_pct,
       n_tup_ins,
       n_tup_upd,
       n_tup_del,
       last_autovacuum,
       last_autoanalyze,
       age(c.relfrozenxid) AS xid_age
FROM pg_stat_user_tables s
JOIN pg_class c ON c.relname = s.relname
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = s.schemaname
ORDER BY n_dead_tup DESC
LIMIT 50;

-- Database-level temp, block, and transaction indicators.
SELECT datname,
       numbackends,
       xact_commit,
       xact_rollback,
       blks_read,
       blks_hit,
       temp_files,
       pg_size_pretty(temp_bytes) AS temp_bytes,
       deadlocks,
       checksum_failures,
       stats_reset
FROM pg_stat_database
WHERE datname = current_database();
