const depots = [
  ["A", "品川", "https://toeibus.com/archives/17332"],
  ["Y", "港南", "https://toeibus.com/archives/17334"],
  ["B", "渋谷", "https://toeibus.com/archives/17336"],
  ["C", "新宿", "https://toeibus.com/archives/17366"],
  ["D", "杉並", "https://toeibus.com/archives/17338"],
  ["W", "青梅", "https://toeibus.com/archives/17344"],
  ["E", "小滝橋", "https://toeibus.com/archives/17340"],
  ["T", "早稲田", "https://toeibus.com/archives/17342"],
  ["F", "練馬", "https://toeibus.com/archives/17346"],
  ["P", "巣鴨", "https://toeibus.com/archives/17348"],
  ["N", "北", "https://toeibus.com/archives/17350"],
  ["H", "千住", "https://toeibus.com/archives/17352"],
  ["K", "南千住", "https://toeibus.com/archives/17354"],
  ["Z", "青戸", "https://toeibus.com/archives/17356"],
  ["L", "江東", "https://toeibus.com/archives/17358"],
  ["R", "臨海", "https://toeibus.com/archives/17362"],
  ["V", "江戸川", "https://toeibus.com/archives/17360"],
  ["S", "深川", "https://toeibus.com/archives/17364"],
  ["J", "有明", "https://toeibus.com/archives/23880"],
];

function htmlText(html) {
  return html
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function scrapeDepot([depotCode, depotName, sourceUrl]) {
  const response = await fetch(sourceUrl, {
    headers: { "User-Agent": "ToeiBusOperations/1.0 (vehicle depot mapping; public data attribution)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`車両配置表 ${depotName}: HTTP ${response.status}`);
  const html = await response.text();
  const vehicles = [];

  for (const [, row] of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, cell]) => htmlText(cell));
    const vehicleId = cells[2]?.toUpperCase();
    if (!vehicleId || !/^[A-Z]{1,2}\d{3,4}$/.test(vehicleId)) continue;
    vehicles.push({ vehicle_id: vehicleId, depot_code: depotCode, depot_name: depotName, source_url: sourceUrl });
  }

  if (vehicles.length < 10) throw new Error(`車両配置表 ${depotName}: 局番を十分に読み取れませんでした`);
  return vehicles;
}

export async function loadVehicleDepotMap({ supabase, activeVehicleIds }) {
  const latest = await supabase("vehicle_depot_assignments?select=fetched_at&order=fetched_at.desc&limit=1");
  const now = Date.now();
  const fetchedAt = latest[0]?.fetched_at ? Date.parse(latest[0].fetched_at) : 0;
  if (!fetchedAt || now - fetchedAt > 24 * 60 * 60 * 1000) {
    try {
      const rows = [];
      for (let offset = 0; offset < depots.length; offset += 4) {
        const batch = await Promise.all(depots.slice(offset, offset + 4).map(scrapeDepot));
        rows.push(...batch.flat());
      }

      const assignments = new Map();
      const conflicts = new Set();
      for (const row of rows) {
        if (conflicts.has(row.vehicle_id)) continue;
        const prior = assignments.get(row.vehicle_id);
        if (prior && prior.depot_code !== row.depot_code) {
          assignments.delete(row.vehicle_id);
          conflicts.add(row.vehicle_id);
          continue;
        }
        assignments.set(row.vehicle_id, row);
      }
      if (assignments.size < 500) throw new Error(`車両配置表から ${assignments.size} 台しか取得できませんでした`);

      const timestamp = new Date().toISOString();
      const mappedRows = [...assignments.values()].map(row => ({ ...row, fetched_at: timestamp }));
      for (let offset = 0; offset < mappedRows.length; offset += 500) {
        await supabase("vehicle_depot_assignments?on_conflict=vehicle_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(mappedRows.slice(offset, offset + 500)),
        });
      }
      const staleQuery = new URLSearchParams({ fetched_at: `lt.${timestamp}` });
      await supabase(`vehicle_depot_assignments?${staleQuery}`, {
        method: "DELETE",
        headers: { Prefer: "return=minimal" },
      });
      console.log(`Updated vehicle/depot table: ${assignments.size} vehicle IDs from the published depot lists.`);
      if (conflicts.size) console.warn(`Excluded ${conflicts.size} vehicle IDs listed under multiple depots.`);
    } catch (error) {
      if (!fetchedAt) throw error;
      console.warn(`Could not refresh vehicle/depot table; using the last saved copy: ${error instanceof Error ? error.message : error}`);
    }
  }

  const ids = [...new Set(activeVehicleIds.map(id => id.trim().toUpperCase()).filter(Boolean))];
  const map = new Map();
  for (let offset = 0; offset < ids.length; offset += 150) {
    const chunk = ids.slice(offset, offset + 150);
    const query = new URLSearchParams({
      select: "vehicle_id,depot_code",
      vehicle_id: `in.(${chunk.join(",")})`,
    });
    const found = await supabase(`vehicle_depot_assignments?${query}`);
    for (const row of found) map.set(row.vehicle_id, row.depot_code);
  }
  return map;
}
