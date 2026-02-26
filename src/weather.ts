export async function getWeather(location: string): Promise<string> {
  try {
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "pi-assistant/1.0" },
    });
    if (!res.ok) throw new Error(`Weather API error ${res.status}`);
    const data = await res.json() as any;

    const current = data.current_condition?.[0];
    if (!current) return `Could not find weather data for "${location}".`;

    const area = data.nearest_area?.[0];
    const locationName = area
      ? `${area.areaName?.[0]?.value || location}, ${area.country?.[0]?.value || ""}`
      : location;

    const temp_f = current.temp_F;
    const temp_c = current.temp_C;
    const feels_f = current.FeelsLikeF;
    const feels_c = current.FeelsLikeC;
    const desc = current.weatherDesc?.[0]?.value || "Unknown";
    const humidity = current.humidity;
    const wind_mph = current.windspeedMiles;
    const wind_dir = current.winddir16Point;
    const uv = current.uvIndex;
    const visibility = current.visibilityMiles;

    let result = `Current weather for ${locationName}:\n`;
    result += `  Condition: ${desc}\n`;
    result += `  Temperature: ${temp_f}°F (${temp_c}°C)\n`;
    result += `  Feels like: ${feels_f}°F (${feels_c}°C)\n`;
    result += `  Humidity: ${humidity}%\n`;
    result += `  Wind: ${wind_mph} mph ${wind_dir}\n`;
    result += `  UV Index: ${uv}\n`;
    result += `  Visibility: ${visibility} miles\n`;

    const forecast = data.weather;
    if (forecast && forecast.length > 0) {
      result += `\n3-Day Forecast:\n`;
      for (const day of forecast.slice(0, 3)) {
        const date = day.date;
        const maxF = day.maxtempF;
        const minF = day.mintempF;
        const maxC = day.maxtempC;
        const minC = day.mintempC;
        const hourly = day.hourly;
        const midday = hourly?.[4] || hourly?.[0];
        const dayDesc = midday?.weatherDesc?.[0]?.value || "N/A";
        const chanceRain = midday?.chanceofrain || "0";
        result += `  ${date}: ${dayDesc}, ${minF}-${maxF}°F (${minC}-${maxC}°C), Rain: ${chanceRain}%\n`;
      }
    }

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Weather error:", msg);
    return `Unable to get weather for "${location}": ${msg}`;
  }
}
