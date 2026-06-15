/**
 * web_search tool for pi, powered by the Kagi Search API.
 *
 * Runs a premium web search through Kagi and returns a readable, ranked list
 * of results (title, URL, snippet, date). Supports the different Kagi search
 * workflows (web, news, videos, images, podcasts), region/date filtering, and
 * optional full-page markdown extraction of the top results.
 *
 * Requires a `KAGI_API_KEY` environment variable. Get one at
 * https://kagi.com/api/keys (see https://kagi.com/api/docs/openapi).
 *
 * Install: copy/symlink this directory into ~/.pi/agent/extensions/ or
 * .pi/extensions/, or test with `pi -e ./index.ts`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";

const KAGI_API_BASE = "https://kagi.com/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

/* ---------------- parameters ---------------- */

const parameters = Type.Object({
	query: Type.String({
		description:
			"The search query. Supports Kagi search operators (e.g. `site:`, " +
			"quoted phrases, `-` to exclude, `@r` snaps).",
	}),
	workflow: Type.Optional(
		StringEnum(["search", "news", "videos", "images", "podcasts"] as const, {
			description:
				"Type of results to return. Defaults to 'search' (general web results).",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 100,
			description:
				"Maximum number of results to return (1-100). If omitted, returns " +
				"all results from a single pass.",
		}),
	),
	region: Type.Optional(
		Type.String({
			description:
				"Localize results to a region using an ISO 3166-1 Alpha-2 country " +
				"code (e.g. 'US', 'GB', 'DE').",
		}),
	),
	time_range: Type.Optional(
		StringEnum(["day", "week", "month"] as const, {
			description:
				"Only return pages updated/published within this interval relative " +
				"to today.",
		}),
	),
	after: Type.Optional(
		Type.String({
			description:
				"Only return results published/updated after this date (YYYY-MM-DD).",
		}),
	),
	before: Type.Optional(
		Type.String({
			description:
				"Only return results published/updated before this date (YYYY-MM-DD).",
		}),
	),
	extract: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 10,
			description:
				"Fetch full-page markdown content for this many of the top results " +
				"(1-10). Incurs extra cost at your Kagi Extract API rate. The " +
				"extracted content replaces each result's snippet.",
		}),
	),
	safe_search: Type.Optional(
		Type.Boolean({
			description:
				"Whether to filter potentially NSFW content. Defaults to true.",
		}),
	),
});

export type WebSearchInput = Static<typeof parameters>;

/* ---------------- Kagi API types ---------------- */

interface KagiImage {
	url: string;
	height?: number;
	width?: number;
}

interface KagiResult {
	url?: string;
	title?: string;
	snippet?: string;
	time?: string;
	image?: KagiImage;
	props?: Record<string, unknown>;
}

interface KagiSearchResponse {
	meta?: { trace?: string; node?: string; ms?: number };
	data?: Record<string, KagiResult[] | undefined>;
}

interface WebSearchDetails {
	query: string;
	workflow: string;
	resultCount: number;
	ms?: number;
	trace?: string;
	extracted?: number;
	truncated?: boolean;
	tempFile?: string;
	error?: string;
}

/* ---------------- helpers ---------------- */

// Which Kagi data collection is the primary one for each workflow.
const PRIMARY_COLLECTION: Record<string, string> = {
	search: "search",
	news: "news",
	videos: "video",
	images: "image",
	podcasts: "podcast",
};

// Collections worth surfacing above the main results when present.
const FEATURED_COLLECTIONS = ["direct_answer", "infobox", "weather"] as const;

function decodeBasicEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'");
}

function cleanSnippet(snippet: string | undefined): string {
	if (!snippet) return "";
	return decodeBasicEntities(snippet).replace(/\s+/g, " ").trim();
}

function formatResult(result: KagiResult, index: number): string {
	const title = cleanSnippet(result.title) || "(untitled)";
	const lines: string[] = [`${index}. ${title}`];
	if (result.url) lines.push(`   ${result.url}`);

	const meta: string[] = [];
	if (result.time) meta.push(result.time);
	if (result.image?.url && !result.url) meta.push(`image: ${result.image.url}`);
	if (meta.length) lines.push(`   ${meta.join("  ·  ")}`);

	const snippet = cleanSnippet(result.snippet);
	if (snippet) {
		// Indent each wrapped line of the snippet.
		for (const para of snippet.split(/\n+/)) {
			if (para.trim()) lines.push(`   ${para.trim()}`);
		}
	}
	return lines.join("\n");
}

function formatFeatured(name: string, results: KagiResult[]): string {
	const label = name.replace(/_/g, " ").toUpperCase();
	const parts: string[] = [`[${label}]`];
	for (const r of results) {
		const title = cleanSnippet(r.title);
		const snippet = cleanSnippet(r.snippet);
		const body = [title, snippet].filter(Boolean).join(" — ");
		if (body) parts.push(body);
		if (r.url) parts.push(`   ${r.url}`);
	}
	return parts.join("\n");
}

/* ---------------- extension ---------------- */

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web with Kagi and return ranked results (title, URL, " +
			"snippet, date). Use this to find current information, sources, " +
			"documentation, news, or to discover URLs to read in detail. " +
			"Set `extract` to also pull full-page markdown for the top results.",
		promptSnippet:
			"Search the web via Kagi for current information and source URLs",
		promptGuidelines: [
			"Use web_search to find up-to-date information or discover relevant URLs before reading them.",
		],
		parameters,

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const apiKey = process.env.KAGI_API_KEY;
			if (!apiKey) {
				throw new Error(
					"KAGI_API_KEY environment variable is not set. Get an API key at " +
						"https://kagi.com/api/keys and export it before starting pi.",
				);
			}

			const workflow = params.workflow ?? "search";

			onUpdate?.({
				content: [{ type: "text", text: `Searching Kagi for "${params.query}"...` }],
			});

			// Build request body from the simplified parameters.
			const body: Record<string, unknown> = {
				query: params.query,
				workflow,
			};
			if (params.limit !== undefined) body.limit = params.limit;
			if (params.safe_search !== undefined) body.safe_search = params.safe_search;
			if (params.extract !== undefined) body.extract = { count: params.extract };

			if (params.region || params.after || params.before) {
				const filters: Record<string, unknown> = {};
				if (params.region) filters.region = params.region;
				if (params.after) filters.after = params.after;
				if (params.before) filters.before = params.before;
				body.filters = filters;
			}
			if (params.time_range) {
				body.lens = { time_relative: params.time_range };
			}

			// Combine the agent abort signal with a request timeout.
			const timeoutController = new AbortController();
			const timer = setTimeout(
				() => timeoutController.abort(),
				DEFAULT_TIMEOUT_MS,
			);
			const onAbort = () => timeoutController.abort();
			signal?.addEventListener("abort", onAbort);

			let response: Response;
			try {
				response = await fetch(`${KAGI_API_BASE}/search`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify(body),
					signal: timeoutController.signal,
				});
			} catch (err) {
				if (signal?.aborted) throw new Error("Search cancelled");
				if (timeoutController.signal.aborted) {
					throw new Error(
						`Kagi search timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`,
					);
				}
				throw new Error(
					`Failed to reach Kagi API: ${err instanceof Error ? err.message : String(err)}`,
				);
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}

			if (!response.ok) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {
					/* ignore */
				}
				const trace = response.headers.get("x-kagi-trace");
				const hints: Record<number, string> = {
					401: "Invalid or missing API key.",
					403: "API access forbidden — check that the Search API is enabled for your account.",
					429: "Rate limited — slow down and retry.",
				};
				let msg = `Kagi API error: HTTP ${response.status} ${response.statusText}`;
				if (hints[response.status]) msg += ` (${hints[response.status]})`;
				if (detail) msg += `\n${detail.slice(0, 500)}`;
				if (trace) msg += `\n[trace: ${trace}]`;
				throw new Error(msg);
			}

			const payload = (await response.json()) as KagiSearchResponse;
			const data = payload.data ?? {};

			const primaryKey = PRIMARY_COLLECTION[workflow] ?? "search";
			const primary = (data[primaryKey] ?? []).filter((r) => r.url || r.image);

			// Featured blocks (direct answers, infobox, weather) shown first.
			const featuredBlocks: string[] = [];
			for (const name of FEATURED_COLLECTIONS) {
				const items = data[name];
				if (items && items.length) featuredBlocks.push(formatFeatured(name, items));
			}

			const details: WebSearchDetails = {
				query: params.query,
				workflow,
				resultCount: primary.length,
				ms: payload.meta?.ms,
				trace: payload.meta?.trace,
				extracted: params.extract,
			};

			if (primary.length === 0 && featuredBlocks.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No results found for "${params.query}" (workflow: ${workflow}).`,
						},
					],
					details,
				};
			}

			// Assemble the human/LLM-readable output.
			const header = `Kagi ${workflow} results for "${params.query}" — ${primary.length} result(s)`;
			const sections: string[] = [header];
			if (featuredBlocks.length) sections.push(featuredBlocks.join("\n\n"));
			if (primary.length) {
				sections.push(
					primary.map((r, i) => formatResult(r, i + 1)).join("\n\n"),
				);
			}
			const full = sections.join("\n\n");

			const truncation = truncateHead(full, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let output = truncation.content;
			details.truncated = truncation.truncated;

			if (truncation.truncated) {
				const tempFile = join(
					tmpdir(),
					`pi-web-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
				);
				writeFileSync(tempFile, full, "utf8");
				details.tempFile = tempFile;
				output += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
				output += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				output += ` Full results saved to: ${tempFile}]`;
			}

			return {
				content: [{ type: "text" as const, text: output }],
				details,
			};
		},

		renderCall(args, theme) {
			let line = theme.fg("toolTitle", theme.bold("web_search "));
			line += theme.fg("accent", args?.query ?? "");
			const flags: string[] = [];
			if (args?.workflow && args.workflow !== "search") flags.push(args.workflow);
			if (args?.region) flags.push(args.region);
			if (args?.time_range) flags.push(args.time_range);
			if (args?.extract) flags.push(`extract:${args.extract}`);
			if (flags.length) line += theme.fg("dim", ` (${flags.join(", ")})`);
			return new Text(line, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching..."), 0, 0);
			}
			const details = result.details as WebSearchDetails | undefined;
			let line = theme.fg("success", "✓ ");
			line += theme.bold(`${details?.resultCount ?? 0} result(s)`);
			const meta: string[] = [];
			if (details?.workflow && details.workflow !== "search") meta.push(details.workflow);
			if (details?.extracted) meta.push(`extracted ${details.extracted}`);
			if (details?.ms !== undefined) meta.push(`${details.ms}ms`);
			if (details?.truncated) meta.push("truncated");
			if (meta.length) line += " " + theme.fg("dim", `(${meta.join(", ")})`);

			if (expanded) {
				const text = result.content?.find((c) => c.type === "text");
				if (text && "text" in text) {
					line += "\n" + theme.fg("muted", text.text);
				}
			}
			return new Text(line, 0, 0);
		},
	});
}
