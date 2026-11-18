import "server-only";
import { FeedStatus, Vehicle } from "./types";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { odptUrlWithKey } from "./odpt-url";

const cache: { status: FeedStatus | null; fetchedAt: number; busy: boolean } = { status: null, fetchedAt: 0, busy: false };
const REFRESH_MS = 15_000;
const STALE_MS = 120_000;

async function fetchFeed(url: string, key: string) {
  const response = await fetch(odptUrlWithKey(url, key), { next: { revalidate: 15 }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`ODPT応答: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function parseFeed(bytes: Uint8Array): { vehicles: Vehicle[]; generatedAt: string | null } {
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
  const timestamp = feed.header?.timestamp ? Number(feed.header.timestamp) : null;
  const generatedAt = timestamp && Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString() : null;
  const vehicles = feed.entity.flatMap((entity) => {
    const v = entity.vehicle;
    if (!v) return [];
    const vehicle: Vehicle = {
      vehicleId: v.vehicle?.id ?? null, tripId: v.trip?.tripId ?? null, routeId: v.trip?.routeId ?? null,
      latitude: v.position?.latitude ?? null, longitude: v.position?.longitude ?? null,
      bearing: v.position?.bearing ?? null, speed: v.position?.speed ?? null,
      currentStopSequence: v.currentStopSequence ?? null, timestamp: v.timestamp ? Number(v.timestamp) : null,
      nextStopId: null, delaySeconds: null, estimatedArrival: null,
      positionKind: v.position?.latitude != null && v.position?.longitude != null ? "actual" : "unknown",
    };
    return [vehicle];
  });
  return { vehicles, generatedAt };
}

export async function getFeedStatus(): Promise<FeedStatus> {
  const key = process.env.ODPT_API_KEY;
  const url = process.env.ODPT_VEHICLE_POSITIONS_URL;
  if (!key || !url) return { configured: false, updatedAt: null, generatedAt: null, stale: false, error: null, vehicles: [], source: "公共交通オープンデータセンター（ODPT）" };
  if (cache.status && Date.now() - cache.fetchedAt < REFRESH_MS) return cache.status;
  if (cache.busy && cache.status) return cache.status;
  cache.busy = true;
  try {
    const bytes = await fetchFeed(url, key);
    const feed = parseFeed(bytes);
    const ageMs = feed.generatedAt ? Date.now() - Date.parse(feed.generatedAt) : 0;
    const status: FeedStatus = { configured: true, updatedAt: new Date().toISOString(), generatedAt: feed.generatedAt, stale: Boolean(feed.generatedAt && ageMs > STALE_MS), error: null, vehicles: feed.vehicles, source: "公共交通オープンデータセンター（ODPT）" };
    cache.status = status; cache.fetchedAt = Date.now(); return status;
  } catch (e) {
    if (cache.status) return { ...cache.status, stale: Date.now() - cache.fetchedAt > STALE_MS, error: e instanceof Error ? e.message : "データ取得に失敗しました" };
    return { configured: true, updatedAt: null, generatedAt: null, stale: true, error: e instanceof Error ? e.message : "データ取得に失敗しました", vehicles: [], source: "公共交通オープンデータセンター（ODPT）" };
  } finally { cache.busy = false; }
}
