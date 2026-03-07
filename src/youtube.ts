import { getAccessToken } from "./gmail.js";

const BASE_URL = "https://www.googleapis.com/youtube/v3";
const TIMEOUT_MS = 15000;

async function ytFetch(endpoint: string, params: Record<string, string>): Promise<{ ok: boolean; data: any; raw: string }> {
  const token = await getAccessToken();
  if (!token) {
    return { ok: false, data: null, raw: "Google not connected — visit /api/gmail/auth to connect" };
  }

  const url = new URL(`${BASE_URL}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const text = await res.text();
    if (!res.ok) {
      const errMsg = text.slice(0, 1000);
      console.error(`[youtube] Error ${res.status} on ${endpoint}:`, errMsg);

      if (res.status === 401) {
        return { ok: false, data: null, raw: "Google authorization expired — visit /api/gmail/auth to reconnect" };
      }
      if (res.status === 403) {
        return { ok: false, data: null, raw: `Insufficient permissions or quota exceeded: ${errMsg}` };
      }
      return { ok: false, data: null, raw: `YouTube API error ${res.status}: ${errMsg}` };
    }

    try {
      const data = JSON.parse(text);
      return { ok: true, data, raw: text };
    } catch {
      return { ok: true, data: null, raw: text };
    }
  } catch (err: any) {
    if (err.name === "AbortError") {
      return { ok: false, data: null, raw: "YouTube API request timed out" };
    }
    console.error(`[youtube] Fetch error on ${endpoint}:`, err.message);
    return { ok: false, data: null, raw: `Error: ${err.message}` };
  }
}

function formatDuration(iso: string): string {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return iso;
  const h = match[1] ? `${match[1]}:` : "";
  const m = (match[2] || "0").padStart(h ? 2 : 1, "0");
  const s = (match[3] || "0").padStart(2, "0");
  return `${h}${m}:${s}`;
}

function formatCount(n: string | number): string {
  const num = typeof n === "string" ? parseInt(n) : n;
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toString();
}

export async function youtubeSearch(query: string, maxResults: number = 10): Promise<string> {
  const result = await ytFetch("search", {
    part: "snippet",
    type: "video",
    q: query,
    maxResults: String(maxResults),
    order: "relevance",
  });
  if (!result.ok) return result.raw;

  const items = result.data?.items;
  if (!items || items.length === 0) return `No videos found for "${query}".`;

  const lines = items.map((item: any, i: number) => {
    const s = item.snippet;
    const videoId = item.id?.videoId;
    const published = s.publishedAt ? new Date(s.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
    return `${i + 1}. ${s.title}\n   Channel: ${s.channelTitle}\n   Published: ${published}\n   ID: ${videoId}\n   URL: https://youtube.com/watch?v=${videoId}`;
  });

  return `YouTube results for "${query}" (${items.length}):\n\n${lines.join("\n\n")}`;
}

export async function youtubeVideoDetails(videoId: string): Promise<string> {
  const result = await ytFetch("videos", {
    part: "snippet,statistics,contentDetails",
    id: videoId,
  });
  if (!result.ok) return result.raw;

  const items = result.data?.items;
  if (!items || items.length === 0) return "Video not found.";

  const v = items[0];
  const s = v.snippet;
  const stats = v.statistics;
  const duration = v.contentDetails?.duration ? formatDuration(v.contentDetails.duration) : "?";

  const lines = [
    `Title: ${s.title}`,
    `Channel: ${s.channelTitle}`,
    `Published: ${s.publishedAt ? new Date(s.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "?"}`,
    `Duration: ${duration}`,
    `Views: ${stats.viewCount ? formatCount(stats.viewCount) : "?"}`,
    `Likes: ${stats.likeCount ? formatCount(stats.likeCount) : "hidden"}`,
    `Comments: ${stats.commentCount ? formatCount(stats.commentCount) : "disabled"}`,
    `URL: https://youtube.com/watch?v=${videoId}`,
    ``,
    `Description:`,
    (s.description || "(no description)").slice(0, 500),
  ];

  return lines.join("\n");
}

export async function youtubeChannelInfo(channelIdentifier: string): Promise<string> {
  let params: Record<string, string> = {
    part: "snippet,statistics",
  };

  if (channelIdentifier.startsWith("UC") && channelIdentifier.length >= 20) {
    params.id = channelIdentifier;
  } else {
    const searchResult = await ytFetch("search", {
      part: "snippet",
      type: "channel",
      q: channelIdentifier,
      maxResults: "1",
    });
    if (!searchResult.ok) return searchResult.raw;

    const channelId = searchResult.data?.items?.[0]?.id?.channelId;
    if (!channelId) return `Channel "${channelIdentifier}" not found.`;
    params.id = channelId;
  }

  const result = await ytFetch("channels", params);
  if (!result.ok) return result.raw;

  const items = result.data?.items;
  if (!items || items.length === 0) return "Channel not found.";

  const ch = items[0];
  const s = ch.snippet;
  const stats = ch.statistics;

  const lines = [
    `Channel: ${s.title}`,
    `ID: ${ch.id}`,
    s.customUrl ? `Handle: ${s.customUrl}` : null,
    `Created: ${s.publishedAt ? new Date(s.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "?"}`,
    `Subscribers: ${stats.subscriberCount ? formatCount(stats.subscriberCount) : "hidden"}`,
    `Videos: ${stats.videoCount ? formatCount(stats.videoCount) : "?"}`,
    `Total views: ${stats.viewCount ? formatCount(stats.viewCount) : "?"}`,
    `URL: https://youtube.com/channel/${ch.id}`,
    ``,
    `Description:`,
    (s.description || "(no description)").slice(0, 500),
  ].filter(Boolean);

  return lines.join("\n");
}

export async function youtubeTrending(regionCode: string = "US", maxResults: number = 10): Promise<string> {
  const result = await ytFetch("videos", {
    part: "snippet,statistics",
    chart: "mostPopular",
    regionCode,
    maxResults: String(maxResults),
  });
  if (!result.ok) return result.raw;

  const items = result.data?.items;
  if (!items || items.length === 0) return `No trending videos found for region ${regionCode}.`;

  const lines = items.map((v: any, i: number) => {
    const s = v.snippet;
    const stats = v.statistics;
    return `${i + 1}. ${s.title}\n   Channel: ${s.channelTitle}\n   Views: ${stats.viewCount ? formatCount(stats.viewCount) : "?"}\n   URL: https://youtube.com/watch?v=${v.id}`;
  });

  return `Trending on YouTube (${regionCode}, ${items.length}):\n\n${lines.join("\n\n")}`;
}
