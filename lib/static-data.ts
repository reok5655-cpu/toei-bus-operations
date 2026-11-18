import "server-only";
import JSZip from "jszip";
import { Route, Stop } from "./types";
import { odptUrlWithKey } from "./odpt-url";

function csv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (quoted) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; } else if (c === '"') quoted = true; else if (c === ",") { row.push(cell); cell = ""; } else if (c === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; } else cell += c; }
  if (cell || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  const headers = rows.shift() ?? [];
  return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
}

const routeCodeCollator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
const variantOrder = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
function compareRouteNames(left: string, right: string): number {
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");
  const aParts = normalize(left).match(/^(.*?)(\d+)(.*)$/), bParts = normalize(right).match(/^(.*?)(\d+)(.*)$/);
  if (!aParts && !bParts) return routeCodeCollator.compare(normalize(left), normalize(right));
  if (!aParts) return 1;
  if (!bParts) return -1;
  const aNumber = BigInt(aParts[2]), bNumber = BigInt(bParts[2]);
  if (aNumber !== bNumber) return aNumber < bNumber ? -1 : 1;
  const prefixOrder = routeCodeCollator.compare(aParts[1], bParts[1]);
  if (prefixOrder) return prefixOrder;
  const aSuffix = aParts[3], bSuffix = bParts[3];
  const rank = (suffix: string) => { const index = variantOrder.indexOf(suffix[0] ?? ""); return suffix ? (index >= 0 ? index + 1 : 100) : 0; };
  return rank(aSuffix) - rank(bSuffix) || routeCodeCollator.compare(aSuffix, bSuffix);
}

export async function getRoutes(): Promise<{ routes: Route[]; configured: boolean; error: string | null; fetchedAt: string | null }> {
  const url = process.env.ODPT_GTFS_STATIC_URL, key = process.env.ODPT_API_KEY;
  if (!url || !key) return { routes: [], configured: false, error: null, fetchedAt: null };
  try {
    const res = await fetch(odptUrlWithKey(url, key), { next: { revalidate: 21_600 }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`ODPT応答: HTTP ${res.status}`);
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    const read = async (name: string) => { const file = Object.values(zip.files).find(f => f.name.toLowerCase().endsWith(name)); if (!file) return []; return csv(await file.async("text")); };
    const [routeRows, stopRows, tripRows, stopTimeRows] = await Promise.all([read("routes.txt"), read("stops.txt"), read("trips.txt"), read("stop_times.txt")]);
    const stops = new Map(stopRows.map(s => [s.stop_id, { stopId: s.stop_id, stopName: s.stop_name || s.stop_id, latitude: Number.isFinite(Number(s.stop_lat)) ? Number(s.stop_lat) : null, longitude: Number.isFinite(Number(s.stop_lon)) ? Number(s.stop_lon) : null, stopSequence: 0 } as Stop]));
    const tripsByRoute = new Map<string, Record<string, string>[]>();
    for (const t of tripRows) { const list = tripsByRoute.get(t.route_id) ?? []; list.push(t); tripsByRoute.set(t.route_id, list); }
    const stopTimes = new Map<string, { seq: number; id: string }[]>();
    for (const s of stopTimeRows) { const list = stopTimes.get(s.trip_id) ?? []; list.push({ seq: Number(s.stop_sequence), id: s.stop_id }); stopTimes.set(s.trip_id, list); }
    const routes: Route[] = routeRows.map(r => {
      const trips = tripsByRoute.get(r.route_id) ?? [];
      const byDirection = new Map<string, Record<string, string>>();
      for (const t of trips) { const key = t.direction_id || "unknown"; if (!byDirection.has(key)) byDirection.set(key, t); }
      const directions = Array.from(byDirection.entries()).map(([directionId, trip]) => {
        const seq = (stopTimes.get(trip.trip_id) ?? []).sort((a,b) => a.seq-b.seq);
        const stopList = seq.map(x => ({ ...(stops.get(x.id) ?? { stopId:x.id, stopName:x.id, latitude:null, longitude:null }), stopSequence:x.seq }));
        const directionTrips = trips.filter(t => (t.direction_id || "unknown") === directionId);
        const tripDestinations: Record<string, string> = {};
        for (const directionTrip of directionTrips) {
          const tripStops = (stopTimes.get(directionTrip.trip_id) ?? []).slice().sort((a,b) => a.seq-b.seq);
          const finalStop = tripStops.at(-1);
          if (finalStop) tripDestinations[directionTrip.trip_id] = stops.get(finalStop.id)?.stopName ?? finalStop.id;
        }
        return { directionId: directionId === "unknown" ? null : directionId, label: directionId === "0" ? "方向 0" : directionId === "1" ? "方向 1" : `方向 ${directionId}`, stopList, tripIds: directionTrips.map(t => t.trip_id), tripDestinations };
      });
      const list = directions[0]?.stopList ?? [];
      return { routeId: r.route_id, routeShortName: r.route_short_name || null, routeLongName: r.route_long_name || null, originStop: list[0]?.stopName ?? null, destinationStop: list.at(-1)?.stopName ?? null, stopList: list, directions };
    }).sort((a,b) => compareRouteNames(a.routeShortName ?? a.routeId, b.routeShortName ?? b.routeId) || a.routeId.localeCompare(b.routeId, "ja", { numeric:true }));
    return { routes, configured: true, error: null, fetchedAt: new Date().toISOString() };
  } catch (e) { return { routes: [], configured: true, error: e instanceof Error ? e.message : "GTFS-JPを読み込めませんでした", fetchedAt: null }; }
}
