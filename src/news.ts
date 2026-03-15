interface NewsItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  source: string;
}

const RSS_FEEDS: Record<string, string> = {
  "top": "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en",
  "world": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  "business": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  "technology": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  "science": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp0Y1RjU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  "health": "https://news.google.com/rss/topics/CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRFU0FtVnVLQUFQAQ?hl=en-US&gl=US&ceid=US:en",
  "sports": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  "entertainment": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
};

function parseRssItems(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && items.length < 10) {
    const block = match[1];
    const title = block.match(/<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/)?.[1] || block.match(/<title>(.*?)<\/title>/)?.[1] || "";
    const link = block.match(/<link>(.*?)<\/link>/)?.[1] || "";
    const desc = block.match(/<description><!\[CDATA\[(.*?)\]\]>|<description>(.*?)<\/description>/)?.[1] || "";
    const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || "";
    const source = block.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || "";

    const cleanDesc = desc.replace(/<[^>]+>/g, "").trim();
    const cleanTitle = title.replace(/<!\[CDATA\[|\]\]>/g, "").trim();

    if (cleanTitle) {
      items.push({
        title: cleanTitle,
        link,
        description: cleanDesc.slice(0, 200),
        pubDate,
        source,
      });
    }
  }

  return items;
}

export async function getNews(category?: string): Promise<string> {
  try {
    const cat = (category || "top").toLowerCase();
    const feedUrl = RSS_FEEDS[cat];

    if (!feedUrl) {
      const available = Object.keys(RSS_FEEDS).join(", ");
      return `Unknown category "${category}". Available categories: ${available}`;
    }

    const res = await fetch(feedUrl, {
      headers: { "User-Agent": "pi-assistant/1.0" },
    });
    if (!res.ok) throw new Error(`News feed error ${res.status}`);
    const xml = await res.text();

    const items = parseRssItems(xml);
    if (items.length === 0) return `No news articles found for "${cat}".`;

    const lines = items.map((item, i) => {
      const source = item.source ? ` (${item.source})` : "";
      const date = item.pubDate ? new Date(item.pubDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
      return `${i + 1}. ${item.title}${source}\n   ${date}${item.description ? ` — ${item.description}` : ""}`;
    });

    const catLabel = cat.charAt(0).toUpperCase() + cat.slice(1);
    return `${catLabel} News Headlines:\n\n${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("News error:", msg);
    return `Unable to fetch news: ${msg}`;
  }
}

export async function getTopHeadlines(count = 3): Promise<Array<{ title: string; source: string; link: string }>> {
  try {
    const res = await fetch(RSS_FEEDS["top"], {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; pi-assistant/1.0)" },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = parseRssItems(xml);
    return items.slice(0, count).map(item => ({ title: item.title, source: item.source, link: item.link }));
  } catch {
    return [];
  }
}

export async function searchHeadlines(query: string, count = 5): Promise<Array<{ title: string; source: string; link: string }>> {
  try {
    const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; pi-assistant/1.0)" },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = parseRssItems(xml);
    return items.slice(0, count).map(item => ({ title: item.title, source: item.source, link: item.link }));
  } catch {
    return [];
  }
}

export async function searchNews(query: string): Promise<string> {
  try {
    const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": "pi-assistant/1.0" },
    });
    if (!res.ok) throw new Error(`News search error ${res.status}`);
    const xml = await res.text();

    const items = parseRssItems(xml);
    if (items.length === 0) return `No news articles found for "${query}".`;

    const lines = items.map((item, i) => {
      const source = item.source ? ` (${item.source})` : "";
      const date = item.pubDate ? new Date(item.pubDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
      return `${i + 1}. ${item.title}${source}\n   ${date}${item.description ? ` — ${item.description}` : ""}`;
    });

    return `News about "${query}":\n\n${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("News search error:", msg);
    return `Unable to search news for "${query}": ${msg}`;
  }
}
