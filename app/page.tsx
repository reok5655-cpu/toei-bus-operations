"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FeedStatus, Route, RouteDirection, Vehicle } from "@/lib/types";

type RouteResult = { routes: Route[]; configured: boolean; error: string | null; fetchedAt: string | null };
type DirectionGroup = { primary: RouteDirection; opposite: RouteDirection | null };
type OperationCandidate = { tripId: string; routeId: string | null; operationCode: string; count: number; sameVehicleCount: number; confidence: "high" | "medium" | "low"; confidenceShare: number };
type OperationPrediction = { configured: boolean; candidates: OperationCandidate[]; unmappedVehicle?: boolean; error?: string };
const time = (value: string | number | null | undefined) => value ? new Date(typeof value === "number" ? value * 1000 : value).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "不明";
const vehicleIdCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export default function Home() {
  const [data, setData] = useState<RouteResult | null>(null), [feed, setFeed] = useState<FeedStatus | null>(null);
  const [query, setQuery] = useState(""), [searchMode, setSearchMode] = useState<"routes" | "vehicles">("routes"), [selected, setSelected] = useState<Route | null>(null), [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [operationPrediction, setOperationPrediction] = useState<OperationPrediction | null>(null), [operationLoading, setOperationLoading] = useState(false);
  const loadRoutes = useCallback(async () => {
    try {
      const routes = await fetch("/api/routes").then(r => r.json());
      setData(routes); setSelected(current => current ? routes.routes.find((r: Route) => r.routeId === current.routeId) ?? null : null);
    } catch { setData(current => current ? { ...current, error: "系統データの取得に失敗しました" } : null); }
  }, []);
  const loadStatus = useCallback(async () => {
    try { setFeed(await fetch("/api/status", { cache: "no-store" }).then(r => r.json())); }
    catch { setFeed(current => current ? { ...current, error: "サーバーとの通信に失敗しました" } : null); }
  }, []);
  useEffect(() => {
    void loadRoutes(); void loadStatus();
    const statusTimer = setInterval(loadStatus, 15_000);
    const routesTimer = setInterval(loadRoutes, 6 * 60 * 60 * 1000);
    return () => { clearInterval(statusTimer); clearInterval(routesTimer); };
  }, [loadRoutes, loadStatus]);
  useEffect(() => {
    if (!vehicle?.vehicleId || !vehicle.tripId) { setOperationPrediction(null); setOperationLoading(false); return; }
    let cancelled = false;
    setOperationLoading(true);
    const params = new URLSearchParams({ vehicleId: vehicle.vehicleId, tripId: vehicle.tripId });
    if (vehicle.timestamp) params.set("timestamp", String(vehicle.timestamp));
    void fetch(`/api/operations/predict?${params}`).then(response => response.json()).then(result => {
      if (!cancelled) setOperationPrediction(result);
    }).catch(() => {
      if (!cancelled) setOperationPrediction({ configured: true, candidates: [], error: "運用履歴を取得できません" });
    }).finally(() => { if (!cancelled) setOperationLoading(false); });
    return () => { cancelled = true; };
  }, [vehicle?.vehicleId, vehicle?.tripId, vehicle?.timestamp]);
  const routes = data?.routes ?? [];
  const filtered = useMemo(() => searchMode === "routes" ? routes.filter(r => `${r.routeShortName ?? ""} ${r.routeLongName ?? ""} ${r.originStop ?? ""} ${r.destinationStop ?? ""}`.normalize("NFKC").toLowerCase().includes(query.normalize("NFKC").toLowerCase())) : routes, [routes, query, searchMode]);
  const vehicles = useMemo(() => (feed?.vehicles ?? []).filter(v => v.routeId && selected && v.routeId === selected.routeId).sort((a, b) => {
    if (!a.vehicleId) return b.vehicleId ? 1 : 0;
    if (!b.vehicleId) return -1;
    return vehicleIdCollator.compare(a.vehicleId, b.vehicleId) || (a.tripId ?? "").localeCompare(b.tripId ?? "");
  }), [feed?.vehicles, selected?.routeId]);
  const directionGroups = useMemo<DirectionGroup[]>(() => {
    const directions = selected?.directions ?? [];
    const used = new Set<number>();
    return directions.reduce<DirectionGroup[]>((groups, direction, index) => {
      if (used.has(index)) return groups;
      const reverseIndex = directions.findIndex((candidate, candidateIndex) =>
        candidateIndex !== index && !used.has(candidateIndex) &&
        candidate.stopList.length === direction.stopList.length && direction.stopList.every((stop, stopIndex) =>
          stop.stopId === candidate.stopList[candidate.stopList.length - stopIndex - 1]?.stopId));
      used.add(index);
      if (reverseIndex < 0) { groups.push({ primary: direction, opposite: null }); return groups; }
      used.add(reverseIndex);
      groups.push({ primary: direction, opposite: directions[reverseIndex] });
      return groups;
    }, []);
  }, [selected?.directions]);
  const matchingVehicles = useMemo(() => (feed?.vehicles ?? [])
    .filter(v => v.vehicleId?.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => {
      if (!a.vehicleId) return b.vehicleId ? 1 : 0;
      if (!b.vehicleId) return -1;
      return vehicleIdCollator.compare(a.vehicleId, b.vehicleId) ||
        (a.routeId ?? "").localeCompare(b.routeId ?? "", "ja", { numeric: true }) ||
        (a.tripId ?? "").localeCompare(b.tripId ?? "", "ja", { numeric: true });
    }), [feed?.vehicles, query]);
  const stopForVehicle = (v: Vehicle, list: Route["stopList"]) => v.currentStopSequence != null ? list.find(stop => stop.stopSequence === v.currentStopSequence)?.stopName : null;
  const destinationForVehicle = (v: Vehicle) => { const tripId = v.tripId; if (!tripId) return "行き先不明"; return selected?.directions.find(dir => dir.tripDestinations[tripId])?.tripDestinations[tripId] ?? "行き先不明"; };
  const detail = (v: Vehicle) => <button className="vehicle-chip" onClick={() => setVehicle(v)}>{v.vehicleId ?? "車両ID不明"}</button>;
  return <>
    <header className="topbar"><div className="shell topbar-inner"><a className="brand" href="/"><span className="brand-mark">都</span><span>都営バス運用情報</span></a><div className="top-meta">REALTIME OPERATIONS · TOKYO</div></div></header>
    <main className="shell">
      <section className="hero"><div className="eyebrow">TOKYO TOEI BUS</div><h1>バスの運行状況を確認</h1><p className="subtitle">系統や車両番号から、運行情報を検索できます。</p><div className="search-tools"><div className="search-tabs" role="tablist" aria-label="検索対象"><button type="button" role="tab" aria-selected={searchMode === "routes"} className={searchMode === "routes" ? "selected" : ""} onClick={() => { setSearchMode("routes"); setQuery(""); }}>系統検索</button><button type="button" role="tab" aria-selected={searchMode === "vehicles"} className={searchMode === "vehicles" ? "selected" : ""} onClick={() => { setSearchMode("vehicles"); setQuery(""); }}>車両番号検索</button></div><label className="searchbar"><span className="search-icon">⌕</span><input aria-label={searchMode === "routes" ? "系統を検索" : "車両番号を検索"} placeholder={searchMode === "routes" ? "系統番号・停留所で検索" : "車両番号を入力"} value={query} onChange={e => setQuery(e.target.value)} /><button className="clear-search" type="button" aria-label="検索をクリア" onClick={() => setQuery("")} disabled={!query}>クリア</button></label></div>
        {searchMode === "vehicles" && query.trim() && <div className="vehicle-search-results card"><div className="section-head"><span className="section-title">車両検索結果</span><span className="count">{matchingVehicles.length} 台</span></div>{matchingVehicles.length ? <div className="vehicle-search-list">{matchingVehicles.slice(0, 30).map((v, i) => { const route = routes.find(r => r.routeId === v.routeId); return <button className="vehicle-search-item" key={`${v.vehicleId}-${v.tripId}-${i}`} onClick={() => { setSelected(route ?? null); setVehicle(v); }}><span className="vehicle-search-id">{v.vehicleId ?? "車両ID不明"}</span><span className="vehicle-search-meta">{route?.routeShortName ?? v.routeId ?? "系統不明"}{v.tripId ? ` · 便 ${v.tripId}` : ""}</span></button>; })}</div> : <div className="empty">該当する車両が見つかりません。</div>}{matchingVehicles.length > 30 && <div className="small-muted search-limit">先頭30台を表示しています。番号を追加して絞り込んでください。</div>}</div>}
      </section>
      <div className="layout">
        <aside className="card"><div className="section-head"><span className="section-title">系統一覧</span><span className="count">{data ? filtered.length : "…"} 系統</span></div>
          {!data ? <div className="loading">GTFS-JPを確認中…</div> : filtered.length ? <div className="route-list">{filtered.map(r => <button key={r.routeId} className={`route-item ${selected?.routeId === r.routeId ? "active" : ""}`} onClick={() => setSelected(r)}><span className="route-badge">{r.routeShortName ?? "系統"}</span><span className="route-item-copy">{r.routeLongName && <span className="route-name" title={r.routeLongName}>{r.routeLongName}</span>}<span className="route-stops">{r.originStop ?? "停留所不明"} → {r.destinationStop ?? "停留所不明"}</span></span></button>)}</div> : <div className="empty">{data.error ? `GTFS-JPを取得できません: ${data.error}` : data.configured ? "該当する系統がありません" : "ODPTのGTFS-JP URLとAPIキーを設定すると、公式データから系統一覧を表示します。"}</div>}
        </aside>
        <section className="card main-panel">
          {selected ? <><div className="panel-body"><div className="route-heading"><div><h2>{selected.routeShortName ?? selected.routeId}</h2><div className="route-desc">{selected.routeLongName ? `${selected.routeLongName} · ` : ""}{selected.originStop ?? "起点不明"} → {selected.destinationStop ?? "終点不明"}</div></div><span className="pill">{vehicles.length} 台 運行中</span></div><div className="data-line" />
            {directionGroups.length ? <div className="direction-grid">{directionGroups.map(({ primary, opposite }, groupIndex) => {
              const primaryVehicles = vehicles.filter(v => v.tripId && primary.tripIds.includes(v.tripId) && v.currentStopSequence != null);
              const oppositeVehicles = opposite ? vehicles.filter(v => v.tripId && opposite.tripIds.includes(v.tripId) && v.currentStopSequence != null) : [];
              const stopCount = primary.stopList.length;
              return <div className={`direction ${opposite ? "direction-paired" : ""}`} key={`${primary.directionId}-${opposite?.directionId ?? "single"}-${groupIndex}`}>
                <div className="direction-title"><span>{opposite ? `左：${primary.label}　／　右：${opposite.label}` : `${primary.label}　${primary.stopList[0]?.stopName ?? ""} → ${primary.stopList.at(-1)?.stopName ?? ""}`}</span><span className="small-muted">{primaryVehicles.length + oppositeVehicles.length} 台</span></div>
                <div className="direction-inner"><div className={`diagram ${opposite ? "diagram-balanced" : ""}`}>{primary.stopList.map((stop, stopIndex) => {
                  const atPrimaryStop = primaryVehicles.filter(v => v.currentStopSequence === stop.stopSequence);
                  if (!opposite) return <div className={`stop-row ${atPrimaryStop.length ? "occupied" : ""}`} key={`${stop.stopId}-${stopIndex}`}><span className="stop-dot"/><span className="stop-label">{stop.stopName}</span>{atPrimaryStop.map((v, vehicleIndex) => <span key={`${v.vehicleId}-${vehicleIndex}`}>{detail(v)}</span>)}</div>;
                  const oppositeStop = opposite.stopList[stopCount - stopIndex - 1];
                  const atOppositeStop = oppositeVehicles.filter(v => v.currentStopSequence === oppositeStop?.stopSequence);
                  const occupied = atPrimaryStop.length + atOppositeStop.length > 0;
                  return <div className={`stop-row stop-row-balanced ${occupied ? "occupied" : ""}`} key={`${stop.stopId}-${stopIndex}`}>
                    <span className="vehicle-side vehicle-side-left">{atPrimaryStop.map((v, vehicleIndex) => <span key={`${v.vehicleId}-${vehicleIndex}`}>{detail(v)}</span>)}</span>
                    <span className="stop-center"><span className="stop-dot"/><span className="stop-label">{stop.stopName}</span></span>
                    <span className="vehicle-side vehicle-side-right">{atOppositeStop.map((v, vehicleIndex) => <span key={`${v.vehicleId}-${vehicleIndex}`}>{detail(v)}</span>)}</span>
                  </div>;
                })}</div></div>
              </div>;
            })}</div> : <div className="placeholder">この系統の方向別停留所情報がGTFS-JPにありません。</div>}
            <div className="vehicle-list"><div className="section-title">運行中の車両</div>{vehicles.length ? vehicles.map((v,i)=><div className="vehicle-row" key={`${v.vehicleId}-${i}`}><span className="vehicle-identity">{detail(v)}　<span className="small-muted">{v.tripId ? `便 ${v.tripId}` : "便情報不明"}</span></span><span className="vehicle-stats"><span><b>現在地</b> {stopForVehicle(v,selected.stopList) ?? (v.latitude != null ? `${v.latitude.toFixed(4)}, ${v.longitude?.toFixed(4)}` : "位置不明")}</span><span><b>行き先</b> {destinationForVehicle(v)}</span></span></div>) : <div className="empty">{feed?.configured ? "この系統の車両データは現在ありません。" : "GTFS-RT接続の設定後、実際の車両情報を表示します。"}</div>}</div>
          </div></> : <div className="panel-body"><div className="placeholder home-placeholder"><div style={{fontSize:25,marginBottom:10}}>↖</div><strong>系統を選択してください</strong><br/>系統一覧から選ぶと、停留所図と車両情報を表示します。</div>
            {(!data || !feed) ? <div className="notice">系統・車両の運行データを読み込んでいます…</div> : (!data.configured || !feed.configured) && <div className="notice">ODPTの接続設定が確認できません。設定を確認してください。</div>}
          </div>}
          {feed?.error && <div className="notice error" style={{margin:"0 20px 18px"}}>リアルタイムデータを取得できません: {feed.error}{feed.updatedAt ? ` · 最終取得 ${time(feed.updatedAt)}` : ""}{feed.stale ? " · 情報が古い可能性があります" : ""}</div>}
          {feed?.stale && !feed.error && <div className="notice error" style={{margin:"0 20px 18px"}}>表示データが古くなっています。最終取得: {time(feed.updatedAt)}</div>}
          <div className="section-head"><span className="small-muted">{feed?.source ?? "ODPT"} · データ生成時刻 {feed?.generatedAt ? time(feed.generatedAt) : "不明"}</span><span className="small-muted">最終取得 {time(feed?.updatedAt)}</span></div>
        </section>
      </div>
    </main>
    <footer className="footer"><div className="shell footer-inner"><span>データ提供: 公共交通オープンデータセンター（ODPT）</span><span>データの正確性・完全性は保証されません。</span><span>Ver2.0.2</span></div></footer>
    {vehicle && <div className="detail-backdrop" onClick={() => setVehicle(null)}><aside className="detail" onClick={e => e.stopPropagation()}><div className="detail-top"><span className="section-title">車両情報</span><button onClick={() => setVehicle(null)}>閉じる　×</button></div><h2>{vehicle.vehicleId ?? "車両ID不明"}</h2><div className="small-muted">現在の運行情報</div><dl className="detail-dl"><div><dt>系統</dt><dd>{selected?.routeShortName ?? vehicle.routeId ?? "不明"}</dd></div><div><dt>便ID</dt><dd>{vehicle.tripId ?? "不明"}</dd></div><div><dt>行き先</dt><dd>{destinationForVehicle(vehicle)}</dd></div><div><dt>車両位置</dt><dd>{vehicle.latitude != null ? `${vehicle.latitude.toFixed(6)}, ${vehicle.longitude?.toFixed(6)}` : "位置不明"}</dd></div><div><dt>位置の種類</dt><dd>{vehicle.positionKind === "actual" ? "実測位置" : vehicle.positionKind === "estimated" ? "推定位置" : "不明"}</dd></div><div><dt>次停留所</dt><dd>{vehicle.nextStopId ?? "不明"}</dd></div><div><dt>進行方向</dt><dd>{vehicle.bearing != null ? `${vehicle.bearing}°` : "不明"}</dd></div><div><dt>速度</dt><dd>{vehicle.speed != null ? `${(vehicle.speed * 3.6).toFixed(1)} km/h` : "不明"}</dd></div><div><dt>最終更新</dt><dd>{time(vehicle.timestamp)}</dd></div><div><dt>次の運用予測</dt><dd>{operationLoading ? "履歴を照合中…" : operationPrediction?.error ? "履歴を読み込めません" : operationPrediction?.unmappedVehicle ? "局番の所属営業所を確認できません" : operationPrediction?.candidates.length ? operationPrediction.candidates.map(candidate => { const route = routes.find(item => item.routeId === candidate.routeId); const destination = route?.directions.map(direction => direction.tripDestinations[candidate.tripId]).find(Boolean) ?? route?.destinationStop ?? "行き先不明"; const routeName = route?.routeShortName ?? candidate.routeId ?? "系統不明"; const confidence = candidate.confidence === "high" ? "高" : candidate.confidence === "medium" ? "中" : "低"; return <span className="operation-candidate" key={`${candidate.tripId}-${candidate.operationCode}`}>{candidate.operationCode} · {routeName}（{destination}） · 確度{confidence} · 実績{candidate.count}件</span>; }) : operationPrediction?.configured ? "運用履歴を蓄積中です" : "運用履歴の保存先を設定すると表示します"}</dd></div></dl><div className="notice">次便候補と運番は、蓄積した車両・便の運行履歴から推定します。ダイヤ変更や車両交換で実際と異なる場合があります。</div></aside></div>}
  </>;
}


