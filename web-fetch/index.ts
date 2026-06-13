/**
 * web_fetch tool for pi
 *
 * Fetches a URL and returns its content as readable text:
 * - HTML pages are converted to plain text (scripts/styles/nav stripped,
 *   links and headings preserved in a markdown-ish format)
 * - JSON is pretty-printed
 * - Other text content types are returned as-is
 *
 * Output is truncated to pi's standard limits (50KB / 2000 lines); the full
 * response is saved to a temp file and its path is reported to the LLM.
 *
 * Install: copy/symlink this file into ~/.pi/agent/extensions/ or
 * .pi/extensions/, or test with `pi -e ./web-fetch.ts`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // hard cap on downloaded body
const DEFAULT_TIMEOUT_MS = 30_000;

const parameters = Type.Object({
	url: Type.String({ description: "URL to fetch (http or https)" }),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (default: 30)" }),
	),
	render: Type.Optional(
		Type.Boolean({
			description:
				"Force rendering with a headless browser (executes JavaScript). " +
				"Default: auto — renders only when the static HTML has no readable text.",
		}),
	),
});

export type WebFetchInput = Static<typeof parameters>;

interface WebFetchDetails {
	url: string;
	finalUrl?: string;
	status?: number;
	contentType?: string;
	title?: string;
	totalBytes?: number;
	truncated?: boolean;
	tempFile?: string;
	rendered?: boolean;
	error?: string;
}

/* ---------------- HTML to text ---------------- */

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	copy: "©",
	reg: "®",
	trade: "™",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "\u2018",
	rsquo: "\u2019",
	ldquo: "\u201c",
	rdquo: "\u201d",
	bull: "•",
	middot: "·",
	times: "×",
	rarr: "→",
	larr: "←",
};

function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
			String.fromCodePoint(parseInt(hex, 16)),
		)
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function extractTitle(html: string): string | undefined {
	const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return m ? decodeEntities(m[1]).trim().replace(/\s+/g, " ") || undefined : undefined;
}

function extractMetaDescription(html: string): string | undefined {
	const m =
		html.match(
			/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i,
		) ??
		html.match(
			/<meta\b[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i,
		);
	return m ? decodeEntities(m[1]).trim() || undefined : undefined;
}

function htmlToText(html: string, baseUrl: string): string {
	let s = html;

	// Drop non-content blocks entirely
	s = s.replace(
		/<(script|style|noscript|svg|head|template|iframe)[^>]*>[\s\S]*?<\/\1>/gi,
		"",
	);
	s = s.replace(/<!--[\s\S]*?-->/g, "");

	// Headings -> markdown
	s = s.replace(
		/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
		(_, level, inner) => `\n\n${"#".repeat(Number(level))} ${inner}\n\n`,
	);

	// Links -> [text](href)
	s = s.replace(
		/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
		(_, href: string, inner: string) => {
			const text = inner.replace(/<[^>]+>/g, "").trim();
			if (!text) return "";
			let resolved = href;
			try {
				resolved = new URL(href, baseUrl).href;
			} catch {
				/* keep raw href */
			}
			return text === resolved ? resolved : `[${text}](${resolved})`;
		},
	);

	// List items
	s = s.replace(/<li\b[^>]*>/gi, "\n- ");

	// Code blocks
	s = s.replace(
		/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
		(_, inner: string) => `\n\`\`\`\n${inner.replace(/<[^>]+>/g, "")}\n\`\`\`\n`,
	);

	// Block-level elements -> line breaks
	s = s.replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote|header|footer|main|aside|figure|dd|dt)>/gi, "\n");
	s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
	s = s.replace(/<\/(td|th)>/gi, "\t");

	// Strip all remaining tags
	s = s.replace(/<[^>]+>/g, "");

	s = decodeEntities(s);

	// Normalize whitespace
	s = s
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return s;
}

/* ---------------- fetch helpers ---------------- */

async function readBody(
	response: Response,
	signal: AbortSignal | undefined,
): Promise<{ bytes: Uint8Array; capped: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) {
		const buf = new Uint8Array(await response.arrayBuffer());
		return { bytes: buf, capped: false };
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	let capped = false;
	for (;;) {
		if (signal?.aborted) {
			await reader.cancel();
			throw new Error("Fetch cancelled");
		}
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.length;
		if (total >= MAX_RESPONSE_BYTES) {
			capped = true;
			await reader.cancel();
			break;
		}
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return { bytes, capped };
}

/* ---------------- browser rendering ---------------- */

interface RenderedPage {
	html: string;
	title?: string;
	finalUrl: string;
}

async function renderWithBrowser(
	url: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<RenderedPage> {
	let chromium: typeof import("playwright").chromium;
	try {
		({ chromium } = await import("playwright"));
	} catch {
		throw new Error(
			"Browser rendering unavailable: playwright is not installed. " +
				"Run `npm install` in the web-fetch extension directory.",
		);
	}

	const browser = await chromium.launch({ headless: true });
	const onAbort = () => void browser.close().catch(() => {});
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const page = await browser.newPage({
			userAgent:
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			viewport: { width: 1280, height: 1024 },
		});
		await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: timeoutMs,
		});
		// Give SPAs a chance to settle; don't fail if the network stays busy.
		await page
			.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 10_000) })
			.catch(() => {});
		const html = await page.content();
		const title = (await page.title()) || undefined;
		const finalUrl = page.url();
		return { html, title, finalUrl };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		await browser.close().catch(() => {});
	}
}

/* ---------------- extension ---------------- */

export default function webFetchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a URL and return its content as readable text. HTML is converted " +
			"to plain text with links preserved, JSON is pretty-printed. " +
			"JavaScript-rendered pages (SPAs) are automatically rendered with a " +
			"headless browser when the static HTML has no readable text; set " +
			"render=true to force browser rendering. Output is " +
			`truncated to ${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} lines; ` +
			"full content is saved to a temp file when truncated.",
		promptSnippet: "Fetch a web page URL and extract its text content",
		promptGuidelines: [
			"Use web_fetch to read documentation, articles, or API responses from URLs the user provides or that you discover.",
		],
		parameters,

		async execute(_toolCallId, params, signal, onUpdate) {
			let url = params.url.trim();
			if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				throw new Error(`Invalid URL: ${params.url}`);
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new Error(`Unsupported protocol: ${parsed.protocol}`);
			}

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${url}...` }],
				details: { url } satisfies WebFetchDetails,
			});

			const timeoutMs = (params.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;

			let text = "";
			let title: string | undefined;
			let finalUrl = url;
			let status: number | undefined;
			let baseType = "";
			let capped = false;
			let rendered = false;

			const renderPage = async () => {
				if (signal?.aborted) throw new Error("Fetch cancelled");
				onUpdate?.({
					content: [
						{ type: "text", text: `Rendering ${url} in headless browser...` },
					],
					details: { url } satisfies WebFetchDetails,
				});
				const page = await renderWithBrowser(url, timeoutMs, signal);
				rendered = true;
				finalUrl = page.finalUrl;
				title = page.title ?? extractTitle(page.html);
				baseType = "text/html";
				text = htmlToText(page.html, finalUrl);
			};

			if (params.render) {
				await renderPage();
				return finish();
			}

			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const combined = signal
				? AbortSignal.any([signal, timeoutSignal])
				: timeoutSignal;

			let response: Response;
			try {
				response = await fetch(url, {
					signal: combined,
					redirect: "follow",
					headers: {
						"User-Agent":
							"Mozilla/5.0 (compatible; pi-web-fetch/1.0; +https://github.com/earendil-works/pi-mono)",
						Accept:
							"text/html,application/xhtml+xml,application/json,text/plain,*/*",
						"Accept-Language": "en-US,en;q=0.9",
					},
				});
			} catch (err) {
				if (timeoutSignal.aborted && !signal?.aborted) {
					throw new Error(`Request timed out after ${timeoutMs / 1000}s: ${url}`);
				}
				if (signal?.aborted) throw new Error("Fetch cancelled");
				throw new Error(
					`Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			const contentType = response.headers.get("content-type") ?? "";
			finalUrl = response.url || url;
			status = response.status;

			if (!response.ok) {
				response.body?.cancel().catch(() => {});
				throw new Error(`HTTP ${response.status} ${response.statusText} for ${finalUrl}`);
			}

			const body = await readBody(response, signal);
			capped = body.capped;
			const raw = new TextDecoder("utf-8", { fatal: false }).decode(body.bytes);

			baseType = contentType.split(";")[0].trim().toLowerCase();

			if (baseType.includes("html") || (!baseType && /^\s*</.test(raw))) {
				title = extractTitle(raw);
				text = htmlToText(raw, finalUrl);
				if (!text.trim()) {
					// Client-rendered SPA shell: retry with a headless browser.
					try {
						await renderPage();
					} catch (renderError) {
						if (signal?.aborted) throw new Error("Fetch cancelled");
						// Rendering failed; report what we can from the static HTML.
						const description = extractMetaDescription(raw);
						const scripts = [...raw.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi)].map(
							(m) => m[1],
						);
						const parts = [
							"[No readable text in HTML body — this page renders its content with client-side JavaScript, and headless browser rendering failed: " +
								(renderError instanceof Error
									? renderError.message
									: String(renderError)) +
								"]",
						];
						if (description) parts.push(`Meta description: ${description}`);
						if (scripts.length) parts.push(`Script bundles: ${scripts.join(", ")}`);
						text = parts.join("\n");
					}
				}
			} else if (baseType.includes("json")) {
				try {
					text = JSON.stringify(JSON.parse(raw), null, 2);
				} catch {
					text = raw;
				}
			} else if (
				baseType.startsWith("text/") ||
				baseType.includes("xml") ||
				baseType === ""
			) {
				text = raw;
			} else {
				throw new Error(
					`Unsupported content type "${baseType}" (${formatSize(body.bytes.length)}) for ${finalUrl}`,
				);
			}

			return finish();

			function finish() {
				if (!text.trim()) {
					throw new Error(`No readable text content extracted from ${finalUrl}`);
				}

				const truncation = truncateHead(text, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});

				const details: WebFetchDetails = {
					url,
					finalUrl,
					status,
					contentType: baseType,
					title,
					totalBytes: Buffer.byteLength(text, "utf8"),
					truncated: truncation.truncated || capped,
					rendered,
				};

				let output = "";
				if (title) output += `Title: ${title}\n`;
				output += `URL: ${finalUrl}\n`;
				if (rendered) output += `(rendered with headless browser)\n`;
				output += `\n${truncation.content}`;

				if (truncation.truncated) {
					const tempFile = join(
						tmpdir(),
						`pi-web-fetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
					);
					writeFileSync(tempFile, text, "utf8");
					details.tempFile = tempFile;
					output += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
					output += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
					output += ` Full content saved to: ${tempFile}]`;
				}
				if (capped) {
					output += `\n\n[Response body capped at ${formatSize(MAX_RESPONSE_BYTES)}]`;
				}

				return {
					content: [{ type: "text" as const, text: output }],
					details,
				};
			}
		},

		renderCall(args, theme) {
			let line = theme.fg("toolTitle", theme.bold("web_fetch "));
			line += theme.fg("accent", args?.url ?? "");
			if (args?.timeout) line += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
			return new Text(line, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as WebFetchDetails | undefined;
			if (isPartial) {
				return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			}
			let line = theme.fg("success", "✓ ");
			if (details?.title) line += theme.bold(details.title) + " ";
			const meta: string[] = [];
			if (details?.status) meta.push(`HTTP ${details.status}`);
			if (details?.rendered) meta.push("rendered");
			if (details?.contentType) meta.push(details.contentType);
			if (details?.totalBytes !== undefined) meta.push(formatSize(details.totalBytes));
			if (details?.truncated) meta.push("truncated");
			if (meta.length) line += theme.fg("dim", `(${meta.join(", ")})`);

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
