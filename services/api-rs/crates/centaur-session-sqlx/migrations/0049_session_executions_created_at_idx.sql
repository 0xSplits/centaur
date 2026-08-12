-- The /api/status report orders and windows session_executions by created_at
-- globally (ORDER BY created_at DESC LIMIT n; created_at > now() - '24 hours';
-- the 7-day histogram). The existing (thread_key, created_at, execution_id)
-- index cannot serve a global recency scan over this append-only, never-pruned
-- table, so give created_at its own index.
create index if not exists session_executions_created_at_idx
    on session_executions (created_at desc);
