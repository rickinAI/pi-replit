export async function search(query: string): Promise<string> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; pi-assistant/1.0)",
      },
    });
    if (!res.ok) throw new Error(`Search error ${res.status}`);
    const html = await res.text();

    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>.*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;

    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < 8) {
      const rawUrl = match[1];
      const title = match[2].replace(/<[^>]+>/g, "").trim();
      const snippet = match[3].replace(/<[^>]+>/g, "").trim();

      let decodedUrl = rawUrl;
      const uddg = rawUrl.match(/uddg=([^&]+)/);
      if (uddg) {
        decodedUrl = decodeURIComponent(uddg[1]);
      }

      if (title && snippet) {
        results.push({ title, url: decodedUrl, snippet });
      }
    }

    if (results.length === 0) {
      const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;
      const titleRegex = /<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/gs;
      const titles: string[] = [];
      const snippets: string[] = [];

      let m;
      while ((m = titleRegex.exec(html)) !== null && titles.length < 8) {
        titles.push(m[1].replace(/<[^>]+>/g, "").trim());
      }
      while ((m = snippetRegex.exec(html)) !== null && snippets.length < 8) {
        snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
      }

      for (let i = 0; i < Math.min(titles.length, snippets.length); i++) {
        results.push({ title: titles[i], url: "", snippet: snippets[i] });
      }
    }

    if (results.length === 0) {
      return `No search results found for "${query}".`;
    }

    const lines = results.map((r, i) =>
      `${i + 1}. ${r.title}\n   ${r.snippet}${r.url ? `\n   URL: ${r.url}` : ""}`
    );

    return `Search results for "${query}":\n\n${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Web search error:", msg);
    return `Unable to search for "${query}": ${msg}`;
  }
}
