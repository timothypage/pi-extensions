/**
 * FLUX image generation tool for pi
 *
 * Generates (and edits) images with Black Forest Labs' FLUX models via the
 * BFL API (https://docs.bfl.ml). The API is asynchronous: we submit a request,
 * poll the returned polling_url until the task is Ready, download the resulting
 * signed image URL, save it to disk, and return it inline so vision-capable
 * models (and the TUI) can see the result.
 *
 * Requires a BFL API key in the BFL_API_KEY environment variable
 * (get one at https://dashboard.bfl.ai/).
 *
 * Install: copy/symlink this directory into ~/.pi/agent/extensions/ or
 * .pi/extensions/, or test with `pi -e ./flux-image/index.ts`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type, type Static } from "typebox";

const API_BASE = "https://api.bfl.ai";
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 5 * 60_000; // give up after 5 minutes
const MAX_INPUT_IMAGES = 8;

// Endpoints documented at https://docs.bfl.ml/quick_start/generating_images
const MODELS = [
	"flux-2-pro-preview",
	"flux-2-pro",
	"flux-2-flex",
	"flux-2-max",
	"flux-2-klein-9b-preview",
	"flux-2-klein-4b",
	"flux-kontext-pro",
	"flux-kontext-max",
	"flux-pro-1.1-ultra",
	"flux-pro-1.1",
	"flux-pro",
	"flux-dev",
] as const;

const parameters = Type.Object({
	prompt: Type.String({
		description: "Text prompt describing the image to generate or the edit to apply.",
	}),
	model: Type.Optional(
		StringEnum(MODELS as unknown as string[], {
			description:
				"FLUX model/endpoint to use. Default: flux-2-pro-preview (latest, recommended).",
		}),
	),
	input_images: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional reference/input images for editing or multi-reference workflows. " +
				`Each entry is a local file path or an http(s) URL. Up to ${MAX_INPUT_IMAGES} images.`,
		}),
	),
	width: Type.Optional(
		Type.Integer({ minimum: 64, description: "Output width in pixels." }),
	),
	height: Type.Optional(
		Type.Integer({ minimum: 64, description: "Output height in pixels." }),
	),
	seed: Type.Optional(
		Type.Integer({ description: "Optional seed for reproducible generations." }),
	),
	output_format: Type.Optional(
		StringEnum(["jpeg", "png"], {
			description: "Output image format. Default: jpeg.",
		}),
	),
	output_path: Type.Optional(
		Type.String({
			description:
				"Where to save the generated image. Defaults to ./flux-<timestamp>.<ext> in the working directory.",
		}),
	),
});

export type FluxImageInput = Static<typeof parameters>;

interface FluxImageDetails {
	model?: string;
	prompt?: string;
	requestId?: string;
	savedPath?: string;
	width?: number;
	height?: number;
	seed?: number;
	cost?: number;
	error?: string;
}

interface SubmitResponse {
	id: string;
	polling_url: string;
}

interface ResultResponse {
	id: string;
	status: string;
	result?: { sample?: string; seed?: number; [k: string]: unknown } | null;
	progress?: number | null;
	details?: Record<string, unknown> | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve an input image to the form the API accepts: pass URLs through, base64-encode local files. */
async function resolveInputImage(value: string, cwd: string): Promise<string> {
	if (/^https?:\/\//i.test(value)) return value;
	const path = resolve(cwd, value.replace(/^@/, ""));
	const buffer = await readFile(path);
	return buffer.toString("base64");
}

export default function fluxImageExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "generate_image",
		label: "Generate Image",
		description:
			"Generate or edit an image with Black Forest Labs FLUX models (text-to-image and " +
			"image editing). Provide a descriptive prompt; optionally pass input_images (file " +
			"paths or URLs) to edit or use as references. The image is saved to disk and the path " +
			"is reported. Requires the BFL_API_KEY environment variable.",
		promptSnippet: "Generate or edit images from a text prompt using FLUX",
		promptGuidelines: [
			"Use generate_image when the user asks to create, generate, edit, or modify an image.",
			"For generate_image edits or style references, pass the source files/URLs via input_images.",
		],
		parameters,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const apiKey = process.env.BFL_API_KEY;
			if (!apiKey) {
				throw new Error(
					"BFL_API_KEY environment variable is not set. Get an API key at https://dashboard.bfl.ai/ and export BFL_API_KEY.",
				);
			}

			const cwd = ctx?.cwd ?? process.cwd();
			const model = params.model ?? "flux-2-pro-preview";
			const outputFormat = params.output_format ?? "jpeg";

			// Build request body.
			const body: Record<string, unknown> = { prompt: params.prompt };
			if (params.width) body.width = params.width;
			if (params.height) body.height = params.height;
			if (params.seed !== undefined) body.seed = params.seed;
			body.output_format = outputFormat;

			if (params.input_images?.length) {
				const images = params.input_images.slice(0, MAX_INPUT_IMAGES);
				for (let i = 0; i < images.length; i++) {
					const key = i === 0 ? "input_image" : `input_image_${i + 1}`;
					body[key] = await resolveInputImage(images[i], cwd);
				}
			}

			onUpdate?.({
				content: [{ type: "text", text: `Submitting ${model} request...` }],
				details: { model, prompt: params.prompt } satisfies FluxImageDetails,
			});

			// 1. Submit the generation task.
			const submitRes = await fetch(`${API_BASE}/v1/${model}`, {
				method: "POST",
				headers: {
					accept: "application/json",
					"x-key": apiKey,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal,
			});

			if (!submitRes.ok) {
				const text = await submitRes.text().catch(() => "");
				if (submitRes.status === 402) {
					throw new Error("Out of credits (HTTP 402). Add credits at https://dashboard.bfl.ai/.");
				}
				if (submitRes.status === 429) {
					throw new Error("Rate limited (HTTP 429): too many active tasks. Try again shortly.");
				}
				throw new Error(`Submit failed: HTTP ${submitRes.status} ${submitRes.statusText} ${text}`.trim());
			}

			const submit = (await submitRes.json()) as SubmitResponse;
			const pollingUrl = submit.polling_url;
			if (!pollingUrl) {
				throw new Error("API response did not include a polling_url.");
			}

			// 2. Poll for the result.
			const deadline = Date.now() + POLL_TIMEOUT_MS;
			let result: ResultResponse | undefined;
			while (Date.now() < deadline) {
				if (signal?.aborted) throw new Error("Generation cancelled");
				await sleep(POLL_INTERVAL_MS);

				const pollRes = await fetch(pollingUrl, {
					method: "GET",
					headers: { accept: "application/json", "x-key": apiKey },
					signal,
				});
				if (!pollRes.ok) {
					const text = await pollRes.text().catch(() => "");
					throw new Error(`Polling failed: HTTP ${pollRes.status} ${pollRes.statusText} ${text}`.trim());
				}

				result = (await pollRes.json()) as ResultResponse;
				const status = result.status;

				if (status === "Ready") break;

				if (
					status === "Error" ||
					status === "Failed" ||
					status === "Task not found" ||
					status === "Request Moderated" ||
					status === "Content Moderated"
				) {
					throw new Error(`Generation ${status}: ${JSON.stringify(result.details ?? result.result ?? {})}`);
				}

				const pct =
					typeof result.progress === "number" ? ` ${Math.round(result.progress * 100)}%` : "";
				onUpdate?.({
					content: [{ type: "text", text: `Status: ${status}${pct}` }],
					details: { model, prompt: params.prompt, requestId: submit.id } satisfies FluxImageDetails,
				});
			}

			const sampleUrl = result?.result?.sample;
			if (!sampleUrl) {
				throw new Error("Generation timed out or returned no image URL.");
			}

			// 3. Download the resulting image (signed URLs expire after ~10 minutes).
			const imgRes = await fetch(sampleUrl, { signal });
			if (!imgRes.ok) {
				throw new Error(`Failed to download result: HTTP ${imgRes.status} ${imgRes.statusText}`);
			}
			const imageBuffer = Buffer.from(await imgRes.arrayBuffer());
			const mimeType = outputFormat === "png" ? "image/png" : "image/jpeg";

			// 4. Save to disk.
			const ext = outputFormat === "png" ? "png" : "jpg";
			const defaultName = `flux-${Date.now()}.${ext}`;
			const savedPath = resolve(cwd, params.output_path ?? defaultName);
			await writeFile(savedPath, imageBuffer);

			const details: FluxImageDetails = {
				model,
				prompt: params.prompt,
				requestId: submit.id,
				savedPath,
				width: params.width,
				height: params.height,
				seed: result?.result?.seed,
				cost: typeof result?.details?.cost === "number" ? (result.details.cost as number) : undefined,
			};

			// 5. Build inline image content (resized to fit pi's inline image limit).
			const resized = await resizeImage(imageBuffer, mimeType);
			let note = `Generated image with ${model}. Saved to: ${savedPath}`;
			if (!resized) {
				note += "\n[Inline preview omitted: image too large to embed.]";
			}

			const content: Array<
				{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
			> = [{ type: "text", text: note }];
			if (resized) {
				content.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
			}

			return { content, details };
		},

		renderCall(args, theme) {
			let line = theme.fg("toolTitle", theme.bold("generate_image "));
			line += theme.fg("accent", args?.model ?? "flux-2-pro-preview");
			if (args?.prompt) {
				const prompt = String(args.prompt);
				const preview = prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
				line += theme.fg("dim", ` "${preview}"`);
			}
			if (args?.input_images?.length) {
				line += theme.fg("dim", ` (+${args.input_images.length} input)`);
			}
			return new Text(line, 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			const details = result.details as FluxImageDetails | undefined;
			if (isPartial) {
				const text = result.content?.find((c) => c.type === "text");
				const label = text && "text" in text ? text.text : "Generating...";
				return new Text(theme.fg("warning", label), 0, 0);
			}
			let line = theme.fg("success", "✓ ");
			if (details?.savedPath) line += theme.bold(details.savedPath);
			const meta: string[] = [];
			if (details?.model) meta.push(details.model);
			if (details?.seed !== undefined) meta.push(`seed ${details.seed}`);
			if (details?.cost !== undefined) meta.push(`${details.cost} credits`);
			if (meta.length) line += theme.fg("dim", ` (${meta.join(", ")})`);
			return new Text(line, 0, 0);
		},
	});
}
