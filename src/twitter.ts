const API_BASE = "https://twitter241.p.rapidapi.com";
const API_HOST = "twitter241.p.rapidapi.com";
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
const TIMEOUT_MS = 15_000;

function cleanUsername(input: string): string {
  return input.replace(/^@/, "").replace(/^https?:\/\/(x\.com|twitter\.com)\//, "").replace(/\/.*$/, "").trim();
}

function extractTweetId(input: string): string | null {
  const match = input.match(/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/);
  if (match) return match[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}

async function apiFetch(endpoint: string, params: Record<string, string>): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${API_BASE}${endpoint}?${new URLSearchParams(params)}`;
    const res = await fetch(url, {
      headers: {
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": API_HOST,
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("X request timed out");
    throw err;
  }
}

function extractTweetFromResult(result: any): any {
  if (!result) return null;
  if (result.__typename === "TweetWithVisibilityResults") return result.tweet || null;
  if (result.__typename === "Tweet" || result.legacy) return result;
  return null;
}

function extractTweetsFromEntries(entries: any[]): any[] {
  const results: any[] = [];
  for (const entry of entries) {
    const content = entry?.content || {};
    const directResult = content?.itemContent?.tweet_results?.result;
    if (directResult) {
      const tweet = extractTweetFromResult(directResult);
      if (tweet) results.push(tweet);
    }
    const items = content?.items || [];
    for (const sub of items) {
      const subResult = sub?.item?.itemContent?.tweet_results?.result;
      if (subResult) {
        const tweet = extractTweetFromResult(subResult);
        if (tweet) results.push(tweet);
      }
    }
  }
  return results;
}

function formatTweetData(tweet: any): { text: string; author: string; handle: string; likes: number; retweets: number; replies: number; views: string | null; date: string; id: string; media: string[]; quoteText: string | null; quoteAuthor: string | null } | null {
  if (!tweet) return null;
  const legacy = tweet.legacy || {};
  const userResult = tweet.core?.user_results?.result || {};
  const userCore = userResult.core || {};
  const fullText = legacy.full_text || "";
  if (!fullText && !legacy.id_str) return null;

  const mediaEntities = legacy.extended_entities?.media || legacy.entities?.media || [];

  let quoteText = null;
  let quoteAuthor = null;
  const qt = tweet.quoted_status_result?.result;
  if (qt) {
    const qtTweet = extractTweetFromResult(qt);
    if (qtTweet?.legacy?.full_text) {
      quoteText = qtTweet.legacy.full_text;
      quoteAuthor = qtTweet.core?.user_results?.result?.core?.screen_name || "unknown";
    }
  }

  return {
    text: fullText,
    author: userCore.name || "",
    handle: userCore.screen_name || "",
    likes: legacy.favorite_count || 0,
    retweets: legacy.retweet_count || 0,
    replies: legacy.reply_count || 0,
    views: tweet.views?.count || null,
    date: legacy.created_at || "",
    id: legacy.id_str || tweet.rest_id || "",
    media: mediaEntities.map((m: any) => m.type || "photo"),
    quoteText,
    quoteAuthor,
  };
}

export async function getUserProfile(username: string): Promise<string> {
  try {
    if (!RAPIDAPI_KEY) return "X/Twitter API not configured (missing API key).";
    const handle = cleanUsername(username);
    const data = await apiFetch("/user", { username: handle });

    const user = data?.result?.data?.user?.result;
    if (!user) return `Could not find X user @${handle}`;

    const core = user.core || {};
    const legacy = user.legacy || {};
    const location = user.location || {};

    const parts = [
      `@${core.screen_name || handle} (${core.name || ""})`,
      legacy.description ? `Bio: ${legacy.description}` : null,
      location.location ? `Location: ${location.location}` : null,
      `Followers: ${(legacy.followers_count || 0).toLocaleString()} | Following: ${(legacy.friends_count || 0).toLocaleString()}`,
      `Tweets: ${(legacy.statuses_count || 0).toLocaleString()} | Likes: ${(legacy.favourites_count || 0).toLocaleString()}`,
      user.is_blue_verified ? "✓ Verified" : null,
      core.created_at ? `Joined: ${new Date(core.created_at).toLocaleDateString("en-US", { month: "long", year: "numeric" })}` : null,
      legacy.entities?.url?.urls?.[0]?.expanded_url ? `Website: ${legacy.entities.url.urls[0].expanded_url}` : null,
      `Profile: https://x.com/${core.screen_name || handle}`,
    ];

    return parts.filter(Boolean).join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching X profile: ${msg}`;
  }
}

export async function getTweet(tweetInput: string): Promise<string> {
  try {
    if (!RAPIDAPI_KEY) return "X/Twitter API not configured (missing API key).";
    const tweetId = extractTweetId(tweetInput);
    if (!tweetId) return "Please provide a valid tweet URL or tweet ID.";

    const data = await apiFetch("/tweet", { pid: tweetId });

    const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions || [];
    for (const inst of instructions) {
      for (const entry of inst.entries || []) {
        const rawResult = entry?.content?.itemContent?.tweet_results?.result;
        const tweet = extractTweetFromResult(rawResult);
        const formatted = formatTweetData(tweet);
        if (formatted && (formatted.id === tweetId || entry.entryId?.includes(tweetId))) {
          const parts = [
            `@${formatted.handle} (${formatted.author})`,
            formatted.text,
            "",
            `${formatted.likes.toLocaleString()} likes | ${formatted.retweets.toLocaleString()} retweets | ${formatted.replies.toLocaleString()} replies${formatted.views ? ` | ${Number(formatted.views).toLocaleString()} views` : ""}`,
            formatted.date ? `Posted: ${new Date(formatted.date).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}` : null,
            `Link: https://x.com/${formatted.handle}/status/${formatted.id}`,
          ];

          if (formatted.media.length > 0) {
            parts.push(`Media: ${formatted.media.length} attachment(s) (${formatted.media.join(", ")})`);
          }

          if (formatted.quoteText) {
            parts.push("", `Quoting @${formatted.quoteAuthor}:`, formatted.quoteText);
          }

          return parts.filter(p => p !== null).join("\n");
        }
      }
    }

    return "Tweet not found or may have been deleted.";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching tweet: ${msg}`;
  }
}

const KNOWN_USER_IDS: Record<string, string> = {
  deltaone: "2704294333", unusual_whales: "1200616796295847936", sentdefender: "1457867047334031360",
  pmarca: "5943622", intelcrab: "3331851939", spectatorindex: "1626294277", zeynep: "65375759",
  billackman: "880412538625810432", elbridgecolby: "443181346", adam_tooze: "3311286493",
  reuters: "1652541", ap: "51241574", bbcbreaking: "5402612", business: "34713362", cnn: "759251",
  cnbc: "20402945", ajenglish: "4970411", axios: "800707492346925056", politico: "9300262", ft: "18949452",
  ianbremmer: "60783724", michaelxpettis: "917683048782503937", rnaudbertrand: "43061739",
  jkylebass: "3005733012", fareedzakaria: "41814169", richardhaass: "195826487", peterzeihan: "1688796138",
  anneapplebaum: "297100174", nouriel: "19224439", brankomilan: "990009265",
  bbcworld: "742143", nytimes: "807095", theeconomist: "5988062", foreignpolicy: "26792275",
  foreignaffairs: "21114659", guardian: "87818409", cfr_org: "17469492", france24: "1994321", dwnews: "6134882",
  lynaldencontact: "823766058909761536", nicktimiraos: "59603406", lukegromen: "2936015319",
  josephwang: "718702333", raoulgmi: "2453385626", biancoresearch: "188369814", elerianm: "332617373",
  naval: "745273", kobeissiletter: "3316376038", balajis: "2178012643",
  wsj: "3108351", imfnews: "25098482", federalreserve: "26538229", bisbank: "90303963", markets: "69620713",
  karpathy: "33836629", sama: "1605", darioamodei: "874126509245476864", emollick: "39125788",
  andrewyngcourses: "216939636", aravsrinivas: "759894532649545732", ylecun: "48008938",
  drjimfan: "1007413134", gdb: "162124540", alexandr_wang: "615818451",
  wired: "1344951", techcrunch: "816653", verge: "275686563", arstechnica: "717313",
  venturebeat: "60642052", newscientist: "19658826",
  saylor: "244647486", apompliano: "339061487", prestonpysh: "538399586",
  dergigi: "1810407120313221120", pete_rizzo_: "341746855", bitfinexed: "851583986270957568",
  coindesk: "1333467482", cointelegraph: "2207129125", theblockcrypto: "916862424325570560",
  bitcoinmagazine: "361289499", decryptmedia: "993530753014054912", thedefiant: "29531842",
  wublockchain: "111533746", cryptobriefing: "1430225550",
};

const userIdCache = new Map<string, { id: string | null; ts: number }>();
const USER_ID_CACHE_TTL = 24 * 60 * 60 * 1000;

async function resolveUserId(username: string): Promise<string | null> {
  const key = username.toLowerCase();
  const known = KNOWN_USER_IDS[key];
  if (known) return known;
  const cached = userIdCache.get(key);
  if (cached && Date.now() - cached.ts < USER_ID_CACHE_TTL) return cached.id;
  try {
    const data = await apiFetch("/user", { username });
    const id = data?.result?.data?.user?.result?.rest_id || null;
    userIdCache.set(key, { id, ts: Date.now() });
    return id;
  } catch (err) {
    if (cached) return cached.id;
    return null;
  }
}

export interface TweetData {
  text: string;
  author: string;
  handle: string;
  likes: number;
  retweets: number;
  views: string | null;
  date: string;
  id: string;
}

export async function getUserTimelineStructured(username: string, count = 5): Promise<TweetData[]> {
  try {
    if (!RAPIDAPI_KEY) return [];
    const handle = cleanUsername(username);
    const maxTweets = Math.min(count, 20);
    const userId = await resolveUserId(handle);
    if (!userId) return [];
    const data = await apiFetch("/user-tweets", { user: userId, count: String(maxTweets) });
    const instructions = data?.result?.timeline?.instructions || [];
    const tweets: TweetData[] = [];
    const seen = new Set<string>();
    for (const inst of instructions) {
      const allTweets = extractTweetsFromEntries(inst.entries || []);
      for (const tweet of allTweets) {
        const formatted = formatTweetData(tweet);
        if (formatted && !seen.has(formatted.id) && !formatted.text.startsWith("RT @")) {
          seen.add(formatted.id);
          tweets.push({
            text: formatted.text.slice(0, 280),
            author: formatted.author,
            handle: formatted.handle,
            likes: formatted.likes,
            retweets: formatted.retweets,
            views: formatted.views,
            date: formatted.date,
            id: formatted.id,
          });
          if (tweets.length >= maxTweets) break;
        }
      }
      if (tweets.length >= maxTweets) break;
    }
    return tweets;
  } catch {
    return [];
  }
}

export async function getUserTimeline(username: string, count = 10): Promise<string> {
  try {
    if (!RAPIDAPI_KEY) return "X/Twitter API not configured (missing API key).";
    const handle = cleanUsername(username);
    const maxTweets = Math.min(count, 20);

    const userId = await resolveUserId(handle);
    if (!userId) return `Could not find X user @${handle}`;

    const data = await apiFetch("/user-tweets", { user: userId, count: String(maxTweets) });

    const instructions = data?.result?.timeline?.instructions || [];
    const tweets: ReturnType<typeof formatTweetData>[] = [];
    const seen = new Set<string>();

    for (const inst of instructions) {
      const allTweets = extractTweetsFromEntries(inst.entries || []);
      for (const tweet of allTweets) {
        const formatted = formatTweetData(tweet);
        if (formatted && !seen.has(formatted.id) && !formatted.text.startsWith("RT @")) {
          seen.add(formatted.id);
          tweets.push(formatted);
          if (tweets.length >= maxTweets) break;
        }
      }
      if (tweets.length >= maxTweets) break;
    }

    if (tweets.length === 0) return `No recent tweets found for @${handle}. The account may be private or have no recent activity.`;

    const lines = tweets.map((t, i) => {
      if (!t) return "";
      const dateStr = t.date ? new Date(t.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
      const stats = `${t.likes.toLocaleString()} likes | ${t.retweets.toLocaleString()} RTs${t.views ? ` | ${Number(t.views).toLocaleString()} views` : ""}`;
      return `${i + 1}. @${t.handle} — ${dateStr}\n   ${t.text.slice(0, 280)}${t.text.length > 280 ? "..." : ""}\n   ${stats} | https://x.com/${t.handle}/status/${t.id}`;
    });

    return `Recent tweets from @${handle}:\n\n${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching timeline: ${msg}`;
  }
}

export async function searchTweets(query: string, count = 10, type: "Latest" | "Top" = "Latest"): Promise<string> {
  try {
    if (!RAPIDAPI_KEY) return "X/Twitter API not configured (missing API key).";
    const maxResults = Math.min(count, 20);

    const data = await apiFetch("/search", { query, count: String(maxResults), type });

    const instructions = data?.result?.timeline?.instructions || [];
    const tweets: ReturnType<typeof formatTweetData>[] = [];
    const seen = new Set<string>();

    for (const inst of instructions) {
      const allTweets = extractTweetsFromEntries(inst.entries || []);
      for (const tweet of allTweets) {
        const formatted = formatTweetData(tweet);
        if (formatted && !seen.has(formatted.id)) {
          seen.add(formatted.id);
          tweets.push(formatted);
          if (tweets.length >= maxResults) break;
        }
      }
      if (tweets.length >= maxResults) break;
    }

    if (tweets.length === 0) return `No tweets found matching "${query}".`;

    const lines = tweets.map((t, i) => {
      if (!t) return "";
      const dateStr = t.date ? new Date(t.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
      const stats = `${t.likes.toLocaleString()} likes | ${t.retweets.toLocaleString()} RTs${t.views ? ` | ${Number(t.views).toLocaleString()} views` : ""}`;
      let line = `${i + 1}. @${t.handle} — ${dateStr}\n   ${t.text.slice(0, 280)}${t.text.length > 280 ? "..." : ""}\n   ${stats} | https://x.com/${t.handle}/status/${t.id}`;
      if (t.quoteText) {
        line += `\n   ↳ Quoting @${t.quoteAuthor}: ${t.quoteText.slice(0, 150)}${(t.quoteText.length || 0) > 150 ? "..." : ""}`;
      }
      return line;
    });

    return `X search results for "${query}" (${type}):\n\n${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error searching X: ${msg}`;
  }
}
