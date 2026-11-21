create table if not exists public.vehicle_current_state (
  service_date date not null,
  vehicle_id text not null,
  depot_code text not null,
  trip_id text not null,
  route_id text,
  direction_id text,
  previous_trip_id text,
  trip_first_seen_at timestamptz not null,
  observed_at timestamptz not null,
  stop_id text,
  stop_sequence integer,
  primary key (service_date, vehicle_id)
);

create table if not exists public.vehicle_depot_assignments (
  vehicle_id text primary key,
  depot_code text not null,
  depot_name text not null,
  source_url text not null,
  fetched_at timestamptz not null
);
create index if not exists vehicle_depot_assignments_fetched_idx
  on public.vehicle_depot_assignments (fetched_at desc);


create table if not exists public.vehicle_trip_runs (
  service_date date not null,
  vehicle_id text not null,
  depot_code text not null,
  weekday_type text not null check (weekday_type in ('weekday', 'saturday', 'sunday')),
  trip_id text not null,
  route_id text,
  direction_id text,
  previous_trip_id text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  start_stop_id text,
  end_stop_id text,
  start_stop_sequence integer,
  end_stop_sequence integer,
  primary key (service_date, vehicle_id, trip_id)
);

create index if not exists vehicle_trip_runs_prediction_idx
  on public.vehicle_trip_runs (depot_code, weekday_type, previous_trip_id, service_date desc);
create index if not exists vehicle_trip_runs_vehicle_idx
  on public.vehicle_trip_runs (service_date, vehicle_id, first_seen_at);

create table if not exists public.operation_clusters (
  depot_code text not null,
  cluster_key text not null,
  cluster_number integer not null,
  created_at timestamptz not null default now(),
  primary key (depot_code, cluster_key),
  unique (depot_code, cluster_number)
);

create table if not exists public.operation_patterns (
  depot_code text not null,
  pattern_key text not null,
  cluster_key text not null,
  operation_number integer not null,
  created_at timestamptz not null default now(),
  primary key (depot_code, pattern_key),
  unique (depot_code, cluster_key, operation_number),
  foreign key (depot_code, cluster_key)
    references public.operation_clusters (depot_code, cluster_key)
);

create or replace function public.register_operation_pattern(
  p_depot_code text,
  p_cluster_key text,
  p_pattern_key text
) returns table (cluster_number integer, operation_number integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cluster_number integer;
  v_operation_number integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_depot_code, 0));

  select c.cluster_number into v_cluster_number
  from public.operation_clusters c
  where c.depot_code = p_depot_code and c.cluster_key = p_cluster_key;

  if v_cluster_number is null then
    select coalesce(max(c.cluster_number), 0) + 1 into v_cluster_number
    from public.operation_clusters c where c.depot_code = p_depot_code;
    insert into public.operation_clusters (depot_code, cluster_key, cluster_number)
    values (p_depot_code, p_cluster_key, v_cluster_number);
  end if;

  select p.operation_number into v_operation_number
  from public.operation_patterns p
  where p.depot_code = p_depot_code and p.pattern_key = p_pattern_key;

  if v_operation_number is null then
    select coalesce(max(p.operation_number), 0) + 1 into v_operation_number
    from public.operation_patterns p
    where p.depot_code = p_depot_code and p.cluster_key = p_cluster_key;
    insert into public.operation_patterns (depot_code, pattern_key, cluster_key, operation_number)
    values (p_depot_code, p_pattern_key, p_cluster_key, v_operation_number);
  end if;

  return query select v_cluster_number, v_operation_number;
end;
$$;

revoke all on function public.register_operation_pattern(text, text, text) from public, anon, authenticated;
grant execute on function public.register_operation_pattern(text, text, text) to service_role;

create or replace function public.register_operation_patterns(p_patterns jsonb)
returns table (depot_code text, pattern_key text, cluster_number integer, operation_number integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pattern record;
begin
  for v_pattern in
    select distinct x.depot_code, x.cluster_key, x.pattern_key
    from jsonb_to_recordset(p_patterns) as x(depot_code text, cluster_key text, pattern_key text)
  loop
    select assigned.cluster_number, assigned.operation_number
      into cluster_number, operation_number
    from public.register_operation_pattern(v_pattern.depot_code, v_pattern.cluster_key, v_pattern.pattern_key) assigned;
    depot_code := v_pattern.depot_code;
    pattern_key := v_pattern.pattern_key;
    return next;
  end loop;
end;
$$;

revoke all on function public.register_operation_patterns(jsonb) from public, anon, authenticated;
grant execute on function public.register_operation_patterns(jsonb) to service_role;

create table if not exists public.daily_vehicle_operations (
  service_date date not null,
  vehicle_id text not null,
  depot_code text not null,
  weekday_type text not null check (weekday_type in ('weekday', 'saturday', 'sunday')),
  operation_code text not null,
  pattern_key text not null,
  trip_ids text[] not null,
  route_ids text[] not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  finalized_at timestamptz not null default now(),
  primary key (service_date, vehicle_id)
);

create table if not exists public.operation_trip_transitions (
  service_date date not null,
  vehicle_id text not null,
  depot_code text not null,
  weekday_type text not null check (weekday_type in ('weekday', 'saturday', 'sunday')),
  operation_code text not null,
  context_trip_id text,
  from_trip_id text not null,
  to_trip_id text not null,
  to_route_id text,
  primary key (service_date, vehicle_id, from_trip_id, to_trip_id)
);

create index if not exists operation_trip_transitions_lookup_idx
  on public.operation_trip_transitions (depot_code, weekday_type, from_trip_id, service_date desc);

alter table public.vehicle_current_state enable row level security;
alter table public.vehicle_depot_assignments enable row level security;
alter table public.vehicle_trip_runs enable row level security;
alter table public.operation_clusters enable row level security;
alter table public.operation_patterns enable row level security;
alter table public.daily_vehicle_operations enable row level security;
alter table public.operation_trip_transitions enable row level security;

revoke all on public.vehicle_current_state, public.vehicle_trip_runs, public.operation_clusters,
  public.operation_patterns, public.daily_vehicle_operations, public.operation_trip_transitions,
  public.vehicle_depot_assignments
  from anon, authenticated;
grant all on public.vehicle_current_state, public.vehicle_trip_runs, public.operation_clusters,
  public.operation_patterns, public.daily_vehicle_operations, public.operation_trip_transitions,
  public.vehicle_depot_assignments
  to service_role;

comment on table public.operation_patterns is
  'Exact observed route/direction sequences. Operation IDs use depot-letter / stable cluster-letter / sequence number.';
