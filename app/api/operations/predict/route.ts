import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Transition = {
  vehicle_id: string;
  context_trip_id: string | null;
  from_trip_id: string;
  to_trip_id: string;
  to_route_id: string | null;
  operation_code: string;
  service_date: string;
};

function serviceDateFor(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const day = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  if (Number(values.hour) < 4) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

function weekdayType(serviceDate: string) {
  const day = new Date(`${serviceDate}T00:00:00.000Z`).getUTCDay();
  return day === 6 ? "saturday" : day === 0 ? "sunday" : "weekday";
}

async function select<T>(url: string, table: string, query: URLSearchParams, key: string): Promise<T[]> {
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`運用履歴を読み込めません: HTTP ${response.status}`);
  return response.json();
}

export async function GET(request: Request) {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ configured: false, candidates: [] });

  const params = new URL(request.url).searchParams;
  const vehicleId = params.get("vehicleId")?.trim();
  const tripId = params.get("tripId")?.trim();
  const observedTimestamp = Number(params.get("timestamp"));
  if (!vehicleId || !tripId) return NextResponse.json({ error: "車両IDと便IDが必要です" }, { status: 400 });
  try {
    const normalizedVehicleId = vehicleId.toUpperCase();
    const depotQuery = new URLSearchParams({
      select: "depot_code",
      vehicle_id: `eq.${normalizedVehicleId}`,
      limit: "1",
    });
    const assignment = await select<{ depot_code: string }>(url, "vehicle_depot_assignments", depotQuery, key);
    const depot = assignment[0]?.depot_code;
    if (!depot) return NextResponse.json({ configured: true, unmappedVehicle: true, candidates: [] });

    const serviceDate = serviceDateFor(Number.isFinite(observedTimestamp) && observedTimestamp > 0 ? new Date(observedTimestamp * 1000) : new Date());
    const weekday = weekdayType(serviceDate);
    const since = new Date(`${serviceDate}T00:00:00.000Z`);
    since.setUTCDate(since.getUTCDate() - 60);
    const historyQuery = new URLSearchParams({
      select: "vehicle_id,context_trip_id,from_trip_id,to_trip_id,to_route_id,operation_code,service_date",
      depot_code: `eq.${depot}`,
      weekday_type: `eq.${weekday}`,
      from_trip_id: `eq.${tripId}`,
      service_date: `gte.${since.toISOString().slice(0, 10)}`,
      order: "service_date.desc",
      limit: "500",
    });
    const stateQuery = new URLSearchParams({
      select: "previous_trip_id",
      service_date: `eq.${serviceDate}`,
      vehicle_id: `eq.${vehicleId}`,
      limit: "1",
    });
    const [history, state] = await Promise.all([
      select<Transition>(url, "operation_trip_transitions", historyQuery, key),
      select<{ previous_trip_id: string | null }>(url, "vehicle_current_state", stateQuery, key),
    ]);
    const contextTripId = state[0]?.previous_trip_id ?? null;
    const exactVehicleRows = history.filter(row => row.vehicle_id === vehicleId);
    const pool = exactVehicleRows.length >= 2 ? exactVehicleRows : history;
    const grouped = new Map<string, { tripId: string; routeId: string | null; operationCode: string; count: number; sameVehicleCount: number; contextCount: number }>();

    for (const row of pool) {
      const identity = `${row.to_trip_id}\u0000${row.operation_code}`;
      const candidate = grouped.get(identity) ?? {
        tripId: row.to_trip_id, routeId: row.to_route_id, operationCode: row.operation_code,
        count: 0, sameVehicleCount: 0, contextCount: 0,
      };
      candidate.count += 1;
      if (row.vehicle_id === vehicleId) candidate.sameVehicleCount += 1;
      if (contextTripId && row.context_trip_id === contextTripId) candidate.contextCount += 1;
      grouped.set(identity, candidate);
    }

    const ranked = [...grouped.values()].sort((a, b) =>
      (b.sameVehicleCount * 3 + b.contextCount * 2 + b.count) - (a.sameVehicleCount * 3 + a.contextCount * 2 + a.count),
    );
    const total = ranked.reduce((sum, item) => sum + (item.sameVehicleCount || item.count), 0);
    const candidates = ranked.slice(0, 3).map(candidate => {
      const evidence = candidate.sameVehicleCount || candidate.count;
      const share = total ? evidence / total : 0;
      const confidence = evidence >= 3 && share >= 0.7 ? "high" : evidence >= 2 ? "medium" : "low";
      return { ...candidate, confidence, confidenceShare: share };
    });

    return NextResponse.json({ configured: true, serviceDate, candidates }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ configured: true, candidates: [], error: error instanceof Error ? error.message : "運用履歴を取得できません" }, { status: 502 });
  }
}
