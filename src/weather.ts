const WMO_CODES: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Foggy", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
  77: "Snow grains", 80: "Slight rain showers", 81: "Moderate rain showers",
  82: "Violent rain showers", 85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};

function cToF(c: number): number {
  return Math.round(c * 9 / 5 + 32);
}

function tempStr(c: number): string {
  return `${Math.round(c)}°C (${cToF(c)}°F)`;
}

async function geocode(location: string): Promise<{ name: string; lat: number; lon: number; country: string; timezone: string } | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json() as any;
  const r = data.results?.[0];
  if (!r) return null;
  return { name: r.name, lat: r.latitude, lon: r.longitude, country: r.country || "", timezone: r.timezone || "auto" };
}

export async function getWeather(location: string): Promise<string> {
  try {
    const geo = await geocode(location);
    if (!geo) return `Could not find location "${location}". Try a city name like "New York" or "London".`;

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}`
      + `&current=temperature_2m,apparent_temperature,weathercode,windspeed_10m,winddirection_10m,relative_humidity_2m,uv_index`
      + `&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max`
      + `&temperature_unit=celsius&windspeed_unit=mph&timezone=${encodeURIComponent(geo.timezone)}&forecast_days=3`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Weather API error ${res.status}`);
    const data = await res.json() as any;

    const c = data.current;
    if (!c) return `Could not get weather data for "${location}".`;

    const condition = WMO_CODES[c.weathercode] || "Unknown";
    const locationLabel = `${geo.name}${geo.country ? `, ${geo.country}` : ""}`;

    let result = `Current weather for ${locationLabel}:\n`;
    result += `  Condition: ${condition}\n`;
    result += `  Temperature: ${tempStr(c.temperature_2m)}\n`;
    result += `  Feels like: ${tempStr(c.apparent_temperature)}\n`;
    result += `  Humidity: ${c.relative_humidity_2m}%\n`;
    result += `  Wind: ${Math.round(c.windspeed_10m)} mph\n`;
    if (c.uv_index !== undefined) result += `  UV Index: ${c.uv_index}\n`;

    const daily = data.daily;
    if (daily?.time?.length > 0) {
      result += `\n3-Day Forecast:\n`;
      for (let i = 0; i < daily.time.length; i++) {
        const date = daily.time[i];
        const hi = Math.round(daily.temperature_2m_max[i]);
        const lo = Math.round(daily.temperature_2m_min[i]);
        const hiF = cToF(daily.temperature_2m_max[i]);
        const loF = cToF(daily.temperature_2m_min[i]);
        const desc = WMO_CODES[daily.weathercode[i]] || "Unknown";
        const rain = daily.precipitation_probability_max[i];
        result += `  ${date}: ${desc}, ${lo}-${hi}°C (${loF}-${hiF}°F), Rain: ${rain}%\n`;
      }
    }

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Weather error:", msg);
    return `Unable to get weather for "${location}": ${msg}`;
  }
}
