/**
 * DuckDuckGo Search Tool — Cross-platform web search
 * 
 * Uses DuckDuckGo's HTML lite endpoint (POST) for searching.
 * No API key required. Works on Linux, Windows, macOS.
 * 
 * Reference: https://lite.duckduckgo.com/
 */

import https from "https";
import http from "http";
import querystring from "querystring";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  query: string;
  limit?: number;      // max results (default: 5)
  timeout?: number;    // ms (default: 10000)
}

/**
 * Fetch text from URL with timeout
 */
function fetchText(url: string, timeout: number = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Request timeout after ${timeout}ms`));
    }, timeout);

    const client = url.startsWith("https") ? https : http;

    const req = client.get(url, { timeout }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        clearTimeout(timer);
        resolve(data);
      });
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.on("timeout", () => {
      clearTimeout(timer);
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

/**
 * POST request to DuckDuckGo Lite
 */
function postToDuckDuckGoLite(
  query: string,
  timeout: number = 10000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Request timeout after ${timeout}ms`));
    }, timeout);

    const postData = querystring.stringify({ q: query });

    const options: https.RequestOptions = {
      hostname: "lite.duckduckgo.com",
      path: "/lite/",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      timeout,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        clearTimeout(timer);
        resolve(data);
      });
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.on("timeout", () => {
      clearTimeout(timer);
      req.destroy();
      reject(new Error("Request timeout"));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Parse DuckDuckGo Lite HTML to extract results
 */
function parseLiteHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo Lite HTML format:
  // <a rel="nofollow" href="URL" class='result-link'>TITLE</a>
  // <td class='result-snippet'>SNIPPET</td>
  
  const linkRegex =
    /<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*class='result-link'[^>]*>([^<]*)<\/a>/gi;
  const snippetRegex = /<td[^>]*class='result-snippet'[^>]*>([\s\S]*?)<\/td>/gi;

  const links: Array<{ url: string; title: string }> = [];
  let match;

  while ((match = linkRegex.exec(html)) !== null && links.length < limit) {
    const url = match[1];
    const title = match[2].trim().replace(/&amp;/g, "&");
    if (url && title && !url.includes("duckduckgo.com")) {
      links.push({ url, title });
    }
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null && snippets.length < limit) {
    const snippet = match[1]
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .trim();
    if (snippet.length > 5) {
      snippets.push(snippet);
    }
  }

  for (let i = 0; i < links.length; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] || "",
    });
  }

  return results;
}

/**
 * Search DuckDuckGo using lite HTML (POST method)
 */
export async function searchDuckDuckGo(
  options: SearchOptions
): Promise<SearchResult[]> {
  const { query, limit = 5, timeout = 10000 } = options;

  if (!query || query.trim().length === 0) {
    throw new Error("Search query is required");
  }

  try {
    const html = await postToDuckDuckGoLite(query.trim(), timeout);
    return parseLiteHtml(html, limit);
  } catch (error) {
    throw new Error(
      `DuckDuckGo search failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

/**
 * Tool definition for LLM function calling
 */
export const duckDuckGoToolDefinition = {
  name: "web_search",
  description:
    "Search the web using DuckDuckGo. Returns search results with titles, URLs, and snippets. No API key required.",
  parameters: {
    type: "object" as const,
    properties: {
      query: {
        type: "string" as const,
        description: "The search query",
      },
      limit: {
        type: "number" as const,
        description: "Maximum number of results (default: 5)",
      },
    },
    required: ["query"],
  },
};

/**
 * Execute DuckDuckGo search tool
 */
export async function executeDuckDuckGoSearch(
  args: Record<string, unknown>
): Promise<string> {
  const query = String(args.query || "");
  const limit = Number(args.limit) || 5;

  if (!query) {
    return JSON.stringify({ error: "query is required" });
  }

  try {
    const results = await searchDuckDuckGo({ query, limit });
    return JSON.stringify(
      {
        query,
        results_count: results.length,
        results,
      },
      null,
      2
    );
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : "Search failed",
      query,
    });
  }
}
