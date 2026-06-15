# flux-image

A `generate_image` tool for [pi](https://github.com/earendil-works/pi-coding-agent)
that generates and edits images with [Black Forest Labs FLUX](https://docs.bfl.ml)
models.

The BFL API is asynchronous: the tool submits a request, polls the returned
`polling_url` until the task is `Ready`, downloads the resulting signed image
URL, saves it to disk, and returns it inline so vision-capable models (and the
TUI) can see the result.

## Setup

Get an API key from <https://dashboard.bfl.ai/> and export it:

```bash
export BFL_API_KEY="your-api-key-here"
```

No `npm install` is needed — the extension only uses Node built-ins and pi's
bundled helpers.

## Usage

Ask pi to create or edit an image, e.g.:

> Generate an image of a serene mountain landscape at golden hour.

> Edit ./photo.jpg to add a hot air balloon in the sky.

### Tool parameters

| Parameter       | Description                                                                 |
| --------------- | --------------------------------------------------------------------------- |
| `prompt`        | **Required.** Text prompt describing the image or edit.                     |
| `model`         | FLUX endpoint. Default `flux-2-pro-preview`. See list below.                |
| `input_images`  | Up to 8 file paths or URLs to edit / use as references.                     |
| `width`         | Output width in pixels (min 64).                                            |
| `height`        | Output height in pixels (min 64).                                          |
| `seed`          | Seed for reproducible generations.                                          |
| `output_format` | `jpeg` (default) or `png`.                                                  |
| `output_path`   | Where to save. Defaults to `./flux-<timestamp>.<ext>`.                      |

### Supported models

`flux-2-pro-preview` (default), `flux-2-pro`, `flux-2-flex`, `flux-2-max`,
`flux-2-klein-9b-preview`, `flux-2-klein-4b`, `flux-kontext-pro`,
`flux-kontext-max`, `flux-pro-1.1-ultra`, `flux-pro-1.1`, `flux-pro`,
`flux-dev`.

## Notes

- Signed result URLs expire ~10 minutes after generation; the tool downloads
  immediately and saves a local copy.
- The API is limited to 24 active tasks (HTTP 429 when exceeded). Running out
  of credits returns HTTP 402.
- Polling gives up after 5 minutes.

## Testing

```bash
pi -e ./flux-image/index.ts
```
