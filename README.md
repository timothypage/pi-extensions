# pi-extensions

Custom extensions for [pi](https://github.com/earendil-works/pi-coding-agent).

> ⚠️ These extensions are 100% vibe coded.

## Extensions

### web-fetch
A `web_fetch` tool that fetches a URL and returns readable text. HTML is
converted to plain text (links preserved) and JavaScript-rendered pages are
handled with a headless-browser rendering fallback (Playwright).

```bash
cd web-fetch
npm install
npx playwright install chromium
```

### flux-image
A `generate_image` tool that generates and edits images with
[Black Forest Labs FLUX](https://docs.bfl.ml) models. Requires a `BFL_API_KEY`
environment variable (get one at <https://dashboard.bfl.ai/>).

```bash
export BFL_API_KEY="your-api-key-here"
```

### exit-alias
Registers an `/exit` command as an alias for `/quit`.

## Installing into pi

Symlink each extension into pi's extensions directory:

```bash
ln -s "$PWD/web-fetch"        ~/.pi/agent/extensions/web-fetch
ln -s "$PWD/flux-image"       ~/.pi/agent/extensions/flux-image
ln -s "$PWD/exit-alias/index.ts" ~/.pi/agent/extensions/exit-alias.ts
```
