const FXTWITTER_BASE = "https://api.fxtwitter.com";
const SYNDICATION_BASE = "https://syndication.twitter.com/srv/timeline-profile/screen-name";
const TIMEOUT_MS = 10_000;

interface TweetData {
  text: string;
  author: string;
  handle: string;
  date: string;
  likes: number;
  retweets: number;
  replies: number;
  url: string;
}

function cleanUsername(input: string): string {
  return input.replace(/^@/, "").replace(/^https?:\/\/(x\.com|twitter\.com)\//, "").replace(/\/.*$/, "").trim();
}

function extractTweetId(input: string): string | null {
  const match = input.match(/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/);
  if (match) return match[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}

async function fetchWithTimeout(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "pi-assistant/1.0", ...headers },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("X request timed out");
    throw err;
  }
}

export async function getUserProfile(username: string): Promise<string> {
  try {
    const handle = cleanUsername(username);
    const res = await fetchWithTimeout(`${FXTWITTER_BASE}/${handle}`);
    if (!res.ok) return `Could not find X user @${handle} (${res.status})`;

    const data = await res.json();
    const u = data.user;
    if (!u) return `Could not find X user @${handle}`;

    const parts = [
      `@${u.screen_name} (${u.name})`,
      u.description ? `Bio: ${u.description}` : null,
      u.location ? `Location: ${u.location}` : null,
      `Followers: ${(u.followers || 0).toLocaleString()} | Following: ${(u.following || 0).toLocaleString()}`,
      `Tweets: ${(u.tweets || 0).toLocaleString()}`,
      u.website ? `Website: ${u.website.url || u.website}` : null,
      u.joined ? `Joined: ${u.joined}` : null,
      `Profile: ${u.url}`,
    ];

    return parts.filter(Boolean).join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching X profile: ${msg}`;
  }
}

export async function getTweet(tweetInput: string): Promise<string> {
  try {
    const tweetId = extractTweetId(tweetInput);
    if (!tweetId) return "Please provide a valid tweet URL or tweet ID.";

    const urlMatch = tweetInput.match(/(?:x\.com|twitter\.com)\/(\w+)\/status\//);
    const handle = urlMatch ? urlMatch[1] : "i";

    const res = await fetchWithTimeout(`${FXTWITTER_BASE}/${handle}/status/${tweetId}`);
    if (!res.ok) return `Could not find that tweet (${res.status})`;

    const data = await res.json();
    const t = data.tweet;
    if (!t) return "Tweet not found or may have been deleted.";

    const parts = [
      `@${t.author?.screen_name || "unknown"} (${t.author?.name || ""})`,
      t.text,
      "",
      `${(t.likes || 0).toLocaleString()} likes | ${(t.retweets || 0).toLocaleString()} retweets | ${(t.replies || 0).toLocaleString()} replies`,
      t.created_at ? `Posted: ${t.created_at}` : null,
      `Link: ${t.url || tweetInput}`,
    ];

    if (t.media?.all?.length) {
      parts.push(`Media: ${t.media.all.length} attachment(s)`);
    }

    if (t.quote) {
      parts.push("", `Quoting @${t.quote.author?.screen_name || "unknown"}:`, t.quote.text);
    }

    return parts.filter(p => p !== null).join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching tweet: ${msg}`;
  }
}

export async function getUserTimeline(username: string, count = 10): Promise<string> {
  try {
    const handle = cleanUsername(username);
    const maxTweets = Math.min(count, 20);

    const res = await fetchWithTimeout(`${SYNDICATION_BASE}/${handle}`);
    if (!res.ok) return `Could not fetch timeline for @${handle} (${res.status})`;

    const html = await res.text();

    const tweets: TweetData[] = [];
    const tweetRegex = /"full_text":"((?:[^"\\]|\\.)*)"/g;
    const nameRegex = /"name":"((?:[^"\\]|\\.)*)"/g;
    const screenNameRegex = /"screen_name":"((?:[^"\\]|\\.)*)"/g;
    const dateRegex = /"created_at":"((?:[^"\\]|\\.)*)"/g;
    const likeRegex = /"favorite_count":(\d+)/g;
    const rtRegex = /"retweet_count":(\d+)/g;
    const replyRegex = /"reply_count":(\d+)/g;
    const idRegex = /"id_str":"(\d+)"/g;

    const texts: string[] = [];
    const names: string[] = [];
    const screenNames: string[] = [];
    const dates: string[] = [];
    const likes: number[] = [];
    const rts: number[] = [];
    const replies: number[] = [];
    const ids: string[] = [];

    let m;
    while ((m = tweetRegex.exec(html)) !== null) texts.push(m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'));
    while ((m = nameRegex.exec(html)) !== null) names.push(m[1]);
    while ((m = screenNameRegex.exec(html)) !== null) screenNames.push(m[1]);
    while ((m = dateRegex.exec(html)) !== null) dates.push(m[1]);
    while ((m = likeRegex.exec(html)) !== null) likes.push(parseInt(m[1]));
    while ((m = rtRegex.exec(html)) !== null) rts.push(parseInt(m[1]));
    while ((m = replyRegex.exec(html)) !== null) replies.push(parseInt(m[1]));
    while ((m = idRegex.exec(html)) !== null) ids.push(m[1]);

    const seen = new Set<string>();
    for (let i = 0; i < texts.length && tweets.length < maxTweets; i++) {
      const text = texts[i];
      if (seen.has(text) || text.startsWith("RT @")) continue;
      seen.add(text);

      tweets.push({
        text,
        author: names[i] || handle,
        handle: screenNames[i] || handle,
        date: dates[i] ? new Date(dates[i]).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "",
        likes: likes[i] || 0,
        retweets: rts[i] || 0,
        replies: replies[i] || 0,
        url: ids[i] ? `https://x.com/${screenNames[i] || handle}/status/${ids[i]}` : "",
      });
    }

    if (tweets.length === 0) return `No recent tweets found for @${handle}. The account may be private or have no recent activity.`;

    const lines = tweets.map((t, i) => {
      const stats = `${t.likes.toLocaleString()} likes | ${t.retweets.toLocaleString()} RTs`;
      return `${i + 1}. @${t.handle} — ${t.date}\n   ${t.text.slice(0, 280)}${t.text.length > 280 ? "..." : ""}\n   ${stats}${t.url ? ` | ${t.url}` : ""}`;
    });

    return `Recent tweets from @${handle}:\n\n${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching timeline: ${msg}`;
  }
}
