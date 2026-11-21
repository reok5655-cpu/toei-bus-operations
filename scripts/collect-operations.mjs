import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { loadVehicleDepotMap } from "./vehicle-depots.mjs";

const apiKey = process.env.ODPT_API_KEY;
const feedUrl = process.env.ODPT_VEHICLE_POSITIONS_URL;
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!apiKey || !feedUrl || !supabaseUrl || !serviceKey) {
  throw new Error("ODPT_API_KEY, ODPT_VEHICLE_POSITIONS_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY are required.");
}

const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Content-Type": "application/json",
};

async function supabase(path, init = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Supabase ${init.method ?? "GET"} failed: HTTP ${response.status} ${await response.text()}`);
  if (response.status === 204) return null;
  return response.json();
}

async function selectAll(table, query) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await supabase(`${table}?${query}`, {
      headers: { Range: `${offset}-${offset + 999}`, "Range-Unit": "items" },
    });
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

async function upsertRows(table, rows, conflict) {
  for (let i = 0; i < rows.length; i += 500) {
    await supabase(`${table}?on_conflict=${encodeURIComponent(conflict)}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
  }
}

function jstParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function serviceDateFor(date) {
  const parts = jstParts(date);
  const base = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  if (Number(parts.hour) < 4) base.setUTCDate(base.getUTCDate() - 1);
  return base.toISOString().slice(0, 10);
}

function previousDate(isoDate) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function daysBefore(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function weekdayType(isoDate) {
  const day = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
  return day === 6 ? "saturday" : day === 0 ? "sunday" : "weekday";
}

function letters(number) {
  let value = number;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(97 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result || "a";
}

async function closePreviousRun(serviceDate, state) {
  if (!state?.trip_id) return;
  const query = new URLSearchParams({
    service_date: `eq.${serviceDate}`,
    vehicle_id: `eq.${state.vehicle_id}`,
    trip_id: `eq.${state.trip_id}`,
  });
  await supabase(`vehicle_trip_runs?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      last_seen_at: state.observed_at,
      end_stop_id: state.stop_id,
      end_stop_sequence: state.stop_sequence,
    }),
  });
}

async function finalizeServiceDay(serviceDate) {
  const runs = await selectAll("vehicle_trip_runs", `service_date=eq.${serviceDate}&select=service_date,vehicle_id,depot_code,weekday_type,trip_id,route_id,direction_id,first_seen_at,last_seen_at&order=vehicle_id.asc,first_seen_at.asc`);
  if (!runs.length) return;

  const byVehicle = new Map();
  for (const run of runs) {
    const list = byVehicle.get(run.vehicle_id) ?? [];
    list.push(run);
    byVehicle.set(run.vehicle_id, list);
  }

  const prepared = [];
  for (const [vehicleId, vehicleRuns] of byVehicle) {
    const ordered = vehicleRuns.sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at));
    const depot = ordered[0].depot_code;
    const routeIds = ordered.map(run => run.route_id ?? "unknown");
    const directions = ordered.map(run => run.direction_id ?? "?");
    const patternKey = routeIds.map((routeId, i) => `${routeId}:${directions[i]}`).join(">");
    const clusterKey = `${routeIds[0]}>${routeIds.at(-1)}`;
    prepared.push({ vehicleId, ordered, depot, routeIds, patternKey, clusterKey });
  }

  const patterns = [...new Map(prepared.map(item => {
    const key = `${item.depot}\u0000${item.patternKey}`;
    return [key, { depot_code: item.depot, cluster_key: item.clusterKey, pattern_key: item.patternKey }];
  })).values()];
  const assigned = patterns.length ? await supabase("rpc/register_operation_patterns", {
    method: "POST",
    body: JSON.stringify({ p_patterns: patterns }),
  }) : [];
  const operationCodes = new Map(assigned.map(entry => [
    `${entry.depot_code}\u0000${entry.pattern_key}`,
    `${entry.depot_code}-${letters(Number(entry.cluster_number))}-${String(entry.operation_number).padStart(3, "0")}`,
  ]));

  const operations = [];
  const transitions = [];
  for (const { vehicleId, ordered, depot, routeIds, patternKey } of prepared) {
    const operationCode = operationCodes.get(`${depot}\u0000${patternKey}`);
    if (!operationCode) throw new Error(`Could not assign operation ID for ${depot}/${patternKey}`);
    operations.push({
      service_date: serviceDate,
      vehicle_id: vehicleId,
      depot_code: depot,
      weekday_type: ordered[0].weekday_type,
      operation_code: operationCode,
      pattern_key: patternKey,
      trip_ids: ordered.map(run => run.trip_id),
      route_ids: routeIds,
      first_seen_at: ordered[0].first_seen_at,
      last_seen_at: ordered.at(-1).last_seen_at,
    });
    for (let i = 0; i < ordered.length - 1; i += 1) {
      transitions.push({
        service_date: serviceDate,
        vehicle_id: vehicleId,
        depot_code: depot,
        weekday_type: ordered[i].weekday_type,
        operation_code: operationCode,
        context_trip_id: ordered[i - 1]?.trip_id ?? null,
        from_trip_id: ordered[i].trip_id,
        to_trip_id: ordered[i + 1].trip_id,
        to_route_id: ordered[i + 1].route_id,
      });
    }
  }

  await upsertRows("daily_vehicle_operations", operations, "service_date,vehicle_id");
  await upsertRows("operation_trip_transitions", transitions, "service_date,vehicle_id,from_trip_id,to_trip_id");
  console.log(`Finalized ${serviceDate}: ${operations.length} vehicle operations, ${transitions.length} observed transitions.`);
}

async function cleanup(serviceDate) {
  const cutoff = daysBefore(serviceDate, 90);
  for (const table of ["vehicle_trip_runs", "operation_trip_transitions", "daily_vehicle_operations", "vehicle_current_state"]) {
    const query = new URLSearchParams({ service_date: `lt.${cutoff}` });
    await supabase(`${table}?${query}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }
}

const realtimeUrl = new URL(feedUrl);
realtimeUrl.searchParams.set("acl:consumerKey", apiKey);
const realtimeResponse = await fetch(realtimeUrl, { signal: AbortSignal.timeout(20_000) });
if (!realtimeResponse.ok) throw new Error(`ODPT VehiclePosition failed: HTTP ${realtimeResponse.status}`);
const bytes = new Uint8Array(await realtimeResponse.arrayBuffer());
const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
const generatedAt = feed.header?.timestamp ? new Date(Number(feed.header.timestamp) * 1000).toISOString() : new Date().toISOString();
const serviceDate = serviceDateFor(new Date(generatedAt));
const type = weekdayType(serviceDate);
const states = await selectAll("vehicle_current_state", `service_date=eq.${serviceDate}&select=service_date,vehicle_id,depot_code,trip_id,route_id,direction_id,previous_trip_id,trip_first_seen_at,observed_at,stop_id,stop_sequence`);
const previousByVehicle = new Map(states.map(state => [state.vehicle_id, state]));
const activeVehicleIds = feed.entity.map(entity => entity.vehicle?.vehicle?.id).filter(Boolean);
const vehicleDepots = await loadVehicleDepotMap({ supabase, activeVehicleIds });
const currentRuns = [];
const nextStates = [];
let changed = 0;
let unmapped = 0;

for (const entity of feed.entity) {
  const vehicle = entity.vehicle;
  const vehicleId = vehicle?.vehicle?.id?.trim().toUpperCase();
  const tripId = vehicle?.trip?.tripId;
  const depot = vehicleId ? vehicleDepots.get(vehicleId) : null;
  if (!vehicle || !vehicleId || !tripId) continue;
  if (!depot) { unmapped += 1; continue; }
  const old = previousByVehicle.get(vehicleId);
  const observedSeconds = vehicle.timestamp ? Number(vehicle.timestamp) : Number(feed.header?.timestamp ?? 0);
  const observedAt = observedSeconds ? new Date(observedSeconds * 1000).toISOString() : generatedAt;
  const tripChanged = Boolean(old?.trip_id && old.trip_id !== tripId);
  if (tripChanged) {
    await closePreviousRun(serviceDate, old);
    changed += 1;
  }
  const routeId = vehicle.trip?.routeId ?? null;
  const directionId = vehicle.trip?.directionId == null ? null : String(vehicle.trip.directionId);
  const previousTripId = tripChanged ? old.trip_id : old?.previous_trip_id ?? null;
  const firstSeenAt = tripChanged ? observedAt : old?.trip_first_seen_at ?? observedAt;
  const stopId = vehicle.stopId ?? null;
  const stopSequence = vehicle.currentStopSequence == null ? null : Number(vehicle.currentStopSequence);
  currentRuns.push({
    service_date: serviceDate,
    vehicle_id: vehicleId,
    depot_code: depot,
    weekday_type: type,
    trip_id: tripId,
    route_id: routeId,
    direction_id: directionId,
    previous_trip_id: previousTripId,
    first_seen_at: firstSeenAt,
    last_seen_at: observedAt,
    start_stop_id: tripChanged ? stopId : old?.trip_id === tripId ? undefined : stopId,
    end_stop_id: stopId,
    start_stop_sequence: tripChanged ? stopSequence : old?.trip_id === tripId ? undefined : stopSequence,
    end_stop_sequence: stopSequence,
  });
  nextStates.push({
    service_date: serviceDate,
    vehicle_id: vehicleId,
    depot_code: depot,
    trip_id: tripId,
    route_id: routeId,
    direction_id: directionId,
    previous_trip_id: previousTripId,
    trip_first_seen_at: firstSeenAt,
    observed_at: observedAt,
    stop_id: stopId,
    stop_sequence: stopSequence,
  });
}

await upsertRows("vehicle_trip_runs", currentRuns, "service_date,vehicle_id,trip_id");
await upsertRows("vehicle_current_state", nextStates, "service_date,vehicle_id");

const clock = jstParts(new Date());
if (Number(clock.hour) === 4 && Number(clock.minute) < 10) {
  await finalizeServiceDay(previousDate(serviceDate));
  await cleanup(serviceDate);
}
console.log(`Collected ${currentRuns.length} mapped vehicles for ${serviceDate}; ${changed} trip transitions observed; ${unmapped} vehicle IDs are absent from the published depot lists.`);
