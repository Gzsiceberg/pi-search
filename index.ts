/**
 * Web Search & Fetch Extension for pi
 *
 * Two tools for agent-driven web browsing:
 *
 *   web_search  — Returns raw search results (title, URL, snippet) via
 *                 OpenAI Codex/API web_search. Agent decides which to open.
 *
 *   web_fetch   — Fetches a URL and returns clean Markdown text.
 *                 Uses Readability + Turndown for static pages,
 *                 Playwright (headless Chromium) for JS-rendered pages.
 *                 Handles HTML, JS-heavy SPAs, and more.
 *
 * Workflow: search → pick links → fetch pages → follow links → synthesize
 *
 * Auth: openai-codex (OAuth) → openai (API key) → OPENAI_API_KEY env
 * Override: WEBSEARCH_PROVIDER, WEBSEARCH_MODEL env vars
 */

import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MODELS: Record<string, string> = {
	"openai-codex": "gpt-5.2",
	openai: "gpt-4o",
};

type AuthProvider = "openai-codex" | "openai";

type ResolvedAuth = {
	provider: AuthProvider;
	apiKey: string;
	model: string;
};

type WebSearchDetails = {
	query: string;
	resultCount: number;
	provider?: AuthProvider;
	model?: string;
};

type WebFetchDetails = {
	url: string;
	title: string;
	method: string;
	linkCount: number;
};

const AUTH_PROBE_ORDER: readonly AuthProvider[] = ["openai-codex", "openai"];

const FETCH_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 60_000;

const DEFAULT_BLOCKED_WEB_TOOLS = [
	"websearch_cited",
	"duckduckgo_search",
	"mcp_web_search",
	"mcp_fetch",
	"web_search_exa",
	"web_search_tavily",
	"browser_search",
	"browser_fetch",
] as const;

const BASH_WEB_EXECUTABLE_PATTERN = /(?:^|[;&|]\s*)(?:curl|wget|httpie|lynx|w3m|links|xh)(?=\s|$)/i;
const BASH_WEB_URL_PATTERN = /https?:\/\/[^\s"')]+/gi;
const BASH_WEB_INLINE_FETCH_PATTERN = /\bnode\s+-e\s+.*fetch\(|\bpython\s+-c\s+.*requests\./i;
const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLocalWebUrl(rawUrl: string): boolean {
	try {
		return LOCALHOST_HOSTNAMES.has(new URL(rawUrl).hostname.toLowerCase());
	} catch {
		return false;
	}
}

function extractWebUrls(command: string): string[] {
	return Array.from(command.matchAll(BASH_WEB_URL_PATTERN), (match) => match[0]);
}

function isBashWebAccess(command: string): boolean {
	const urls = extractWebUrls(command);
	const hasRemoteUrl = urls.some((url) => !isLocalWebUrl(url));
	if (hasRemoteUrl) return true;

	const hasWebExecutable = BASH_WEB_EXECUTABLE_PATTERN.test(command);
	const hasInlineFetch = BASH_WEB_INLINE_FETCH_PATTERN.test(command);
	if (!hasWebExecutable && !hasInlineFetch) return false;

	if (urls.length === 0) return true;
	return false;
}

// Turndown instance (reused)
const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});

// Remove images and iframes from markdown output (noise for LLMs)
const removedTags = new Set(["IMG", "IFRAME", "VIDEO", "AUDIO", "CANVAS", "SVG"]);
turndown.remove((node) => removedTags.has((node as Element).nodeName));

function isEnvEnabled(name: string, defaultValue = true): boolean {
	const raw = process.env[name];
	if (raw == null) return defaultValue;
	const value = raw.trim().toLowerCase();
	if (value === "" || value === "1" || value === "true" || value === "yes" || value === "on") return true;
	if (value === "0" || value === "false" || value === "no" || value === "off") return false;
	return defaultValue;
}

function parseCsvEnv(name: string): string[] {
	const raw = process.env[name];
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function getBlockedWebTools(): Set<string> {
	const blocked = new Set<string>(DEFAULT_BLOCKED_WEB_TOOLS);
	for (const name of parseCsvEnv("PI_SEARCH_EXTRA_BLOCKED_TOOLS")) blocked.add(name);
	for (const name of parseCsvEnv("PI_SEARCH_ALLOWED_WEB_TOOLS")) blocked.delete(name);
	blocked.delete("web_search");
	blocked.delete("web_fetch");
	return blocked;
}

// ---------------------------------------------------------------------------
// Auth resolution
// ---------------------------------------------------------------------------

async function resolveAuth(ctx: Pick<ExtensionContext, "modelRegistry">): Promise<ResolvedAuth | undefined> {
	const forced = process.env.WEBSEARCH_PROVIDER?.trim().toLowerCase();
	const providers = AUTH_PROBE_ORDER.filter((providerId) => {
		if (!forced) return true;
		return providerId === forced || providerId === `${forced}-codex`;
	});

	for (const providerId of providers) {
		const modelId = process.env.WEBSEARCH_MODEL ?? DEFAULT_MODELS[providerId];
		if (!modelId) continue;

		const model = ctx.modelRegistry.find(providerId, modelId);
		if (model) {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (auth.ok && auth.apiKey) {
				return { provider: providerId, apiKey: auth.apiKey, model: modelId };
			}
		}

		const providerApiKey = await ctx.modelRegistry.getApiKeyForProvider(providerId);
		if (providerApiKey) {
			return { provider: providerId, apiKey: providerApiKey, model: modelId };
		}
	}

	const envOpenAiKey = process.env.OPENAI_API_KEY;
	if (envOpenAiKey && (!forced || forced === "openai")) {
		return { provider: "openai", apiKey: envOpenAiKey, model: process.env.WEBSEARCH_MODEL ?? DEFAULT_MODELS.openai };
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

function isCodexJwt(token: string): boolean {
	const parts = token.split(".");
	if (parts.length !== 3) return false;
	try {
		return !!JSON.parse(Buffer.from(parts[1]!, "base64").toString("utf8"))?.["https://api.openai.com/auth"];
	} catch {
		return false;
	}
}

function extractAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const id = JSON.parse(Buffer.from(parts[1]!, "base64").toString("utf8"))?.["https://api.openai.com/auth"]
			?.chatgpt_account_id;
		return typeof id === "string" && id.trim() ? id.trim() : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// OpenAI web search — returns structured results
// ---------------------------------------------------------------------------

type SearchResult = { title: string; url: string; snippet: string };

function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

async function openaiWebSearch(query: string, model: string, apiKey: string): Promise<SearchResult[]> {
	const isOAuth = isCodexJwt(apiKey);

	const body = {
		model,
		instructions: "Perform the web search. Return a brief summary mentioning each source.",
		input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
		tools: [{ type: "web_search" }],
		include: ["web_search_call.action.sources"],
		store: false,
		stream: true,
		tool_choice: "auto",
		parallel_tool_calls: true,
	};

	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		"OpenAI-Beta": "responses=experimental",
	};

	let url: string;
	if (isOAuth) {
		url = "https://chatgpt.com/backend-api/codex/responses";
		const accountId = extractAccountId(apiKey);
		if (accountId) headers["chatgpt-account-id"] = accountId;
		headers["originator"] = "pi";
	} else {
		url = "https://api.openai.com/v1/responses";
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
	} catch (err) {
		clearTimeout(timeout);
		throw err;
	}

	if (!response.ok) {
		clearTimeout(timeout);
		const text = await response.text().catch(() => "");
		throw new Error(`OpenAI API error ${response.status}: ${text}`);
	}

	const responseObj = await parseSSEResponse(response);
	clearTimeout(timeout);
	return extractSearchResults(responseObj);
}

async function parseSSEResponse(response: Response): Promise<any> {
	const text = await response.text();
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return JSON.parse(trimmed);
		} catch {}
	}
	for (const line of text.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const data = line.slice(6).trim();
		if (!data || data === "[DONE]") continue;
		try {
			const parsed = JSON.parse(data);
			if (parsed.type === "response.done" || parsed.type === "response.completed") return parsed.response;
		} catch {}
	}
	throw new Error("Failed to parse OpenAI SSE response");
}

function extractSearchResults(responseObj: any): SearchResult[] {
	const output = responseObj?.output;
	if (!Array.isArray(output)) return [];

	const results: SearchResult[] = [];
	const seenUrls = new Set<string>();

	// From url_citation annotations (has title + URL)
	for (const item of output) {
		if (item.type !== "message") continue;
		for (const part of item.content ?? []) {
			for (const ann of part.annotations ?? []) {
				if (ann.type !== "url_citation" || !ann.url) continue;
				const url = ann.url.replace(/\?utm_source=openai$/, "");
				if (seenUrls.has(url)) continue;
				seenUrls.add(url);
				const snippet = extractSnippetAround(part.text ?? "", ann.start_index, ann.end_index);
				results.push({ title: ann.title ?? url, url, snippet });
			}
		}
	}

	// Backfill from web_search_call sources
	for (const item of output) {
		if (item.type !== "web_search_call") continue;
		for (const source of item.action?.sources ?? []) {
			if (!source.url) continue;
			const url = source.url.replace(/\?utm_source=openai$/, "");
			if (seenUrls.has(url)) continue;
			seenUrls.add(url);
			results.push({ title: url, url, snippet: "" });
		}
	}

	return results;
}

function extractSnippetAround(text: string, start?: number, end?: number): string {
	if (start == null || end == null || !text) return "";
	const before = Math.max(0, start - 100);
	const after = Math.min(text.length, end + 100);
	let snippet = text.slice(before, after).trim();
	snippet = snippet.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
	if (snippet.length > 300) snippet = snippet.slice(0, 297) + "...";
	return snippet;
}

// ---------------------------------------------------------------------------
// Web fetch — Readability + Turndown, Playwright fallback
// ---------------------------------------------------------------------------

/**
 * Extract readable Markdown from HTML using Readability + Turndown.
 * Returns undefined if Readability can't parse (JS-rendered page, etc).
 */
function htmlToMarkdown(html: string, url: string): { markdown: string; title: string; links: string[] } | undefined {
	const { document } = parseHTML(html);

	// Set the document URL for Readability's relative URL resolution
	try {
		Object.defineProperty(document, "baseURI", { value: url, writable: false });
	} catch {}

	const reader = new Readability(document.cloneNode(true) as any, { charThreshold: 100 });
	const article = reader.parse();

	if (!article?.content) return undefined;

	const markdown = turndown.turndown(article.content);
	const title = article.title ?? "";

	// Extract links from the article HTML
	const links: string[] = [];
	const linkRegex = /href="([^"]+)"/gi;
	let match;
	while ((match = linkRegex.exec(article.content)) !== null) {
		try {
			const resolved = new URL(match[1]!, url).href;
			if (resolved.startsWith("http")) links.push(resolved);
		} catch {}
	}

	return { markdown, title, links: [...new Set(links)] };
}

/**
 * Fetch a page with a simple HTTP request (static HTML).
 */
async function fetchStatic(url: string): Promise<{ html: string; contentType: string; finalUrl: string }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			headers: {
				"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.5",
			},
			signal: controller.signal,
			redirect: "follow",
		});
		clearTimeout(timeout);

		if (!response.ok) throw new Error(`HTTP ${response.status}`);

		const contentType = response.headers.get("content-type") ?? "";
		const html = await response.text();
		return { html, contentType, finalUrl: response.url };
	} catch (err) {
		clearTimeout(timeout);
		throw err;
	}
}

/**
 * Fetch a JS-rendered page using Playwright headless Chromium.
 */
async function fetchWithPlaywright(url: string): Promise<string> {
	const { chromium } = await import("playwright");
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.goto(url, { waitUntil: "networkidle", timeout: FETCH_TIMEOUT_MS });
		const html = await page.content();
		return html;
	} finally {
		await browser.close();
	}
}

/**
 * Main fetch logic: try static first, fall back to Playwright if needed.
 */
async function smartFetch(
	url: string,
	usePlaywright: boolean,
): Promise<{ markdown: string; title: string; links: string[]; method: string }> {
	// 1. Try static fetch + Readability
	if (!usePlaywright) {
		const { html, contentType, finalUrl } = await fetchStatic(url);

		// Non-HTML content — return raw text
		if (!contentType.includes("html")) {
			return {
				markdown: html.length > DEFAULT_MAX_BYTES ? html.slice(0, DEFAULT_MAX_BYTES) + "\n[truncated]" : html,
				title: url,
				links: [],
				method: "static-raw",
			};
		}

		const result = htmlToMarkdown(html, finalUrl);
		if (result && result.markdown.trim().length > 200) {
			return { ...result, method: "static+readability" };
		}

		// Readability failed or returned too little — probably JS-rendered
		// Fall through to Playwright
	}

	// 2. Playwright fallback
	try {
		const html = await fetchWithPlaywright(url);
		const result = htmlToMarkdown(html, url);
		if (result) {
			return { ...result, method: "playwright+readability" };
		}

		// Last resort: basic text extraction from Playwright HTML
		const basicText = html
			.replace(/<script[\s\S]*?<\/script>/gi, "")
			.replace(/<style[\s\S]*?<\/style>/gi, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return { markdown: basicText, title: url, links: [], method: "playwright-raw" };
	} catch (err: any) {
		throw new Error(`Playwright fetch failed: ${err.message}. Try with a different URL.`);
	}
}

// ---------------------------------------------------------------------------
// Test exports (pure helpers)
// ---------------------------------------------------------------------------

export const __testables = {
	isCodexJwt,
	extractAccountId,
	extractSearchResults,
	extractSnippetAround,
	htmlToMarkdown,
	parseSSEResponse,
	resolveAuth,
	isEnvEnabled,
	parseCsvEnv,
	getBlockedWebTools,
	BASH_WEB_EXECUTABLE_PATTERN,
	BASH_WEB_URL_PATTERN,
	BASH_WEB_INLINE_FETCH_PATTERN,
	isBashWebAccess,
};

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function webBrowseExtension(pi: ExtensionAPI) {
	const webPolicyEnabled = isEnvEnabled("PI_SEARCH_ENFORCE_WEB_POLICY", true);
	const bashPolicyEnabled = isEnvEnabled("PI_SEARCH_BLOCK_BASH_WEB", true);
	const blockedWebTools = getBlockedWebTools();

	if (webPolicyEnabled) {
		pi.on("before_agent_start", async (event) => ({
			systemPrompt:
				event.systemPrompt +
				"\n\nWeb policy: use only tools `web_search` and `web_fetch` for web access. Do not use other web-search/web-fetch tools or bash-based fetching.",
		}));

		pi.on("tool_call", async (event) => {
			if (blockedWebTools.has(event.toolName)) {
				return {
					block: true,
					reason: "Blocked by pi-search policy: use `web_search` / `web_fetch` only for web access.",
				};
			}

			if (bashPolicyEnabled && event.toolName === "bash") {
				const command = String((event.input as any)?.command ?? "");
				if (isBashWebAccess(command)) {
					return {
						block: true,
						reason: "Blocked by pi-search policy: web access via bash is disabled. Use `web_search` / `web_fetch`.",
					};
				}
			}
		});
	}

	// ---- web_search ----
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via OpenAI. Returns a list of results with title, URL, and snippet. Use web_fetch to read specific pages. Do NOT call more than 3 times in parallel (rate limit).",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const query = params.query?.trim();
			if (!query) throw new Error("empty query");

			const auth = await resolveAuth(ctx);
			if (!auth) {
				throw new Error("No API key. Use /login (Codex) or set OPENAI_API_KEY.");
			}

			onUpdate?.(textResult(`Searching via ${auth.provider}: ${query}`, {
				query,
				resultCount: 0,
				provider: auth.provider,
				model: auth.model,
			} satisfies WebSearchDetails));

			const results = await openaiWebSearch(query, auth.model, auth.apiKey);
			if (results.length === 0) {
				return textResult(`No results found for: "${query}"`, {
					query,
					resultCount: 0,
					provider: auth.provider,
					model: auth.model,
				} satisfies WebSearchDetails);
			}

			const formatted = results
				.map((r, i) => {
					let entry = `${i + 1}. ${r.title}\n   ${r.url}`;
					if (r.snippet) entry += `\n   ${r.snippet}`;
					return entry;
				})
				.join("\n\n");

			return textResult(formatted, {
				query,
				resultCount: results.length,
				provider: auth.provider,
				model: auth.model,
			} satisfies WebSearchDetails);
		},
	});

	// ---- web_fetch ----
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a web page and extract its content as clean Markdown. Uses Mozilla Readability for article extraction and Playwright for JS-rendered pages. Returns the page text, title, and links found on the page.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			playwright: Type.Optional(
				Type.Boolean({ description: "Force Playwright (headless browser) for JS-heavy pages. Default: false (auto-detects)." }),
			),
		}),

		async execute(_toolCallId, params, _signal, onUpdate) {
			const url = params.url?.trim();
			if (!url) throw new Error("empty url");

			const forcePlaywright = params.playwright ?? false;

			onUpdate?.(textResult(`Fetching ${url}...`, {
				url,
				title: "",
				method: forcePlaywright ? "playwright" : "auto",
				linkCount: 0,
			} satisfies WebFetchDetails));

			const result = await smartFetch(url, forcePlaywright);

			// Truncate if needed
			const truncation = truncateHead(result.markdown, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let output = "";

			// Header
			if (result.title) output += `# ${result.title}\n\n`;
			output += `Source: ${url}\nExtraction: ${result.method}\n\n---\n\n`;

			// Content
			output += truncation.content;

			if (truncation.truncated) {
				output += `\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				output += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
			}

			// Links found on page
			if (result.links.length > 0) {
				const topLinks = result.links.slice(0, 30);
				output += `\n\n---\n\nLinks found on page (${result.links.length} total):\n`;
				output += topLinks.map((l, i) => `${i + 1}. ${l}`).join("\n");
				if (result.links.length > 30) output += `\n... and ${result.links.length - 30} more`;
			}

			return textResult(output, {
				url,
				title: result.title,
				method: result.method,
				linkCount: result.links.length,
			} satisfies WebFetchDetails);
		},
	});
}
