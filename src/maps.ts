const TIMEOUT_MS = 10_000;
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const OSRM_BASE = "https://router.project-osrm.org";
const UA = "pi-assistant/1.0 (personal-project)";

interface GeoResult {
  name: string;
  lat: number;
  lon: number;
  displayName: string;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("Request timed out");
    throw err;
  }
}

async function geocode(query: string): Promise<GeoResult | null> {
  const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  const data = await res.json() as any[];
  if (!data.length) return null;
  const r = data[0];
  return {
    name: r.name || r.display_name.split(",")[0],
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    displayName: r.display_name,
  };
}

function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins} min`;
}

function formatDistance(meters: number): string {
  const miles = meters / 1609.34;
  if (miles >= 1) return `${miles.toFixed(1)} miles`;
  const feet = meters * 3.281;
  return `${Math.round(feet)} ft`;
}

function cleanInstruction(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

export async function getDirections(from: string, to: string, mode?: string): Promise<string> {
  try {
    const travelMode = (mode || "driving").toLowerCase();
    const osrmProfile = travelMode === "walking" || travelMode === "walk" ? "foot"
      : travelMode === "cycling" || travelMode === "bike" || travelMode === "bicycle" ? "bike"
      : "car";

    const [originGeo, destGeo] = await Promise.all([geocode(from), geocode(to)]);

    if (!originGeo) return `Could not find location "${from}". Try being more specific (e.g. include city/state).`;
    if (!destGeo) return `Could not find location "${to}". Try being more specific (e.g. include city/state).`;

    const url = `${OSRM_BASE}/route/v1/${osrmProfile === "car" ? "driving" : osrmProfile}/${originGeo.lon},${originGeo.lat};${destGeo.lon},${destGeo.lat}?overview=false&steps=true&geometries=geojson`;

    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Routing error ${res.status}`);

    const data = await res.json() as any;
    if (data.code !== "Ok" || !data.routes?.length) {
      return `No route found from "${from}" to "${to}" by ${travelMode}. The locations may be on different continents or unreachable.`;
    }

    const route = data.routes[0];
    const totalDist = formatDistance(route.distance);
    const totalTime = formatDuration(route.duration);

    const lines = [
      `Directions from ${originGeo.name} to ${destGeo.name}`,
      `Mode: ${travelMode.charAt(0).toUpperCase() + travelMode.slice(1)}`,
      `Distance: ${totalDist}`,
      `Estimated time: ${totalTime}`,
      "",
    ];

    const steps = route.legs?.[0]?.steps || [];
    const significantSteps = steps.filter((s: any) => s.distance > 30 && s.maneuver?.type !== "arrive" && s.maneuver?.type !== "depart");
    const displaySteps = significantSteps.slice(0, 15);

    if (displaySteps.length > 0) {
      lines.push("Route:");
      displaySteps.forEach((step: any, i: number) => {
        const instruction = cleanInstruction(step.name || step.maneuver?.type || "Continue");
        const dist = formatDistance(step.distance);
        const modifier = step.maneuver?.modifier ? ` ${step.maneuver.modifier}` : "";
        const type = step.maneuver?.type || "";
        const action = type === "turn" ? `Turn${modifier}` :
          type === "merge" ? `Merge${modifier}` :
          type === "fork" ? `Take${modifier} fork` :
          type === "roundabout" ? "Enter roundabout" :
          type === "new name" ? "Continue" :
          type.charAt(0).toUpperCase() + type.slice(1);
        lines.push(`  ${i + 1}. ${action} onto ${instruction} (${dist})`);
      });

      if (significantSteps.length > 15) {
        lines.push(`  ... and ${significantSteps.length - 15} more steps`);
      }
    }

    lines.push("", `From: ${originGeo.displayName}`);
    lines.push(`To: ${destGeo.displayName}`);

    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Directions error:", msg);
    return `Unable to get directions: ${msg}`;
  }
}

export async function searchPlaces(query: string, near?: string): Promise<string> {
  try {
    let url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(query)}&format=json&limit=8&addressdetails=1`;

    if (near) {
      const geo = await geocode(near);
      if (geo) {
        const viewbox = `${geo.lon - 0.1},${geo.lat + 0.1},${geo.lon + 0.1},${geo.lat - 0.1}`;
        url += `&viewbox=${viewbox}&bounded=0`;
      }
    }

    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Places search error ${res.status}`);

    const data = await res.json() as any[];
    if (!data.length) return `No places found for "${query}"${near ? ` near ${near}` : ""}.`;

    const lines = data.map((place: any, i: number) => {
      const name = place.name || place.display_name.split(",")[0];
      const type = place.type ? place.type.replace(/_/g, " ") : "";
      const address = place.display_name;
      return `${i + 1}. ${name}${type ? ` (${type})` : ""}\n   ${address}`;
    });

    const header = near ? `Places matching "${query}" near ${near}:` : `Places matching "${query}":`;
    return `${header}\n\n${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Places search error:", msg);
    return `Unable to search places: ${msg}`;
  }
}
