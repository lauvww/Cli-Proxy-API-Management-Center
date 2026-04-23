# CLI Proxy API Management Center

A single-file Web UI (React + TypeScript) for operating and troubleshooting the **CLI Proxy API** via its **Management API** (config, credentials, logs, and usage).

[中文文档](README_CN.md)

**Main Project**: https://github.com/lauvww/CLIProxyAPI  
**Example URL**: https://remote.router-for.me/  
**Minimum Required Version**: ≥ 2.2.1 (recommended: match the backend release exactly)

Since version 6.0.19, the Web UI ships with the main program; access it via `/management.html` on the API port once the service is running.

## Recent UI Updates

- **Auth pool management** is now treated as a first-class workflow. The Config page keeps the auth-pool mode toggle, while the dedicated Auth Pool page is shown only when the backend reports auth-pool mode enabled.
- The Auth Pool page focuses on the stable single-active-pool runtime model: you can manage multiple pool paths, switch the current pool, edit the current pool routing strategy, search accounts in the current pool, and quickly enable or disable auth files without reopening the full Auth Files page.
- The Usage page now follows backend auth-pool metadata more closely. When auth-pool mode is enabled and no explicit pool filter is provided, the page defaults to the current auth pool and shows a scope hint from the server.
- The Auth Files page keeps using the backend-reported `current_auth_pool` and shared path normalization helpers, so uploads, deletes, edits, and enable/disable actions stay scoped to the current pool.
- The Config page now covers `routing.session-affinity`, `routing.session-affinity-ttl`, and `model-catalog.remote-refresh-enabled`, including runtime hints when the current process is force-overridden by `--remote-model` or `--local-model`.
- The management UI now consumes runtime `auth-index` metadata from backend key endpoints, so config entries can be mapped back to live auth instances more reliably.
- Local builds now stamp the generated `management.html` with a marker so packaged desktop deployments can prefer the locally published management panel instead of overwriting it with the background asset updater.

## What this is (and isn’t)

- This repository is the Web UI only. It talks to the CLI Proxy API **Management API** (`/v0/management`) to read/update config, upload credentials, view logs, and inspect usage.
- It is **not** a proxy and does not forward traffic.

## Current UI Architecture

- The application is a single-file React/Vite management panel that talks to the backend Management API and selected public endpoints such as `/v1/models`.
- Transport logic lives in `src/services/api/*`, while shared application state is handled with Zustand stores for auth, config, models, usage, theme, and notifications.
- `ConfigPage` is source-first. `useVisualConfig` provides the structured visual overlay, while raw YAML editing remains the primary correctness path for complex config edits.
- `AuthPoolPage`, `AuthFilesPage`, and `UsagePage` share path normalization helpers from `src/utils/authPool.ts` so current pool, viewed pool, and runtime scope semantics stay aligned.
- `UsagePage` uses `useUsageData()` as its page-level source and derives charts, cards, request rows, and health views through shared helpers in `src/utils/usage.ts`.
- Model discovery is centralized in `src/stores/useModelsStore.ts`, which supports multi-key fallback and carries backend model-scope metadata so System, Dashboard, and Usage stay consistent.

## Quick start

### Option A: Use the Web UI bundled in CLI Proxy API (recommended)

1. Start your CLI Proxy API service.
2. Open: `http://<host>:<api_port>/management.html`
3. Enter your **management key** and connect.

The address is auto-detected from the current page URL; manual override is supported.

### Option B: Run the dev server

```bash
npm install
npm run dev
```

Open `http://localhost:5173`, then connect to your CLI Proxy API backend instance.

### Option C: Build a single HTML file

```bash
npm install
npm run build
```

- Output: `dist/index.html` (all assets are inlined).
- For CLI Proxy API bundling, the release workflow renames it to `management.html`.
- To preview locally: `npm run preview`

Tip: opening `dist/index.html` via `file://` may be blocked by browser CORS; serving it (preview/static server) is more reliable.

## Connecting to the server

### API address

You can enter any of the following; the UI will normalize it:

- `localhost:8317`
- `http://192.168.1.10:8317`
- `https://example.com:8317`
- `http://example.com:8317/v0/management` (also accepted; the suffix is removed internally)

### Management key (not the same as API keys)

The management key is sent with every request as:

- `Authorization: Bearer <MANAGEMENT_KEY>` (default)

This is different from the proxy `api-keys` you manage inside the UI (those are for client requests to the proxy endpoints).

### Remote management

If you connect from a non-localhost browser, the server must allow remote management (e.g. `allow-remote-management: true`).  
See `api.md` for the full authentication rules, server-side limits, and edge cases.

## What you can manage (mapped to the UI pages)

- **Dashboard**: connection status, server version/build date, quick counts, model availability snapshot.
- **Basic Settings**: debug, proxy URL, request retry, quota fallback (switch project or preview models when limits reached), usage statistics, request logging, file logging, WebSocket auth, and the auth-pool mode toggle.
- **API Keys**: manage proxy `api-keys` (add/edit/delete).
- **AI Providers**:
  - Gemini/Codex/Claude/Vertex key entries (base URL, headers, proxy, model aliases, excluded models, prefix).
  - OpenAI-compatible providers (multiple API keys, custom headers, model alias import via `/v1/models`, optional browser-side "chat/completions" test).
  - Ampcode integration (upstream URL/key, force mappings, model mapping table).
- **Auth Pool**: maintain multiple auth-pool paths, switch the current pool, update the current pool routing strategy, review the single-active-pool runtime behavior, and quickly search/enable/disable auth files in the current pool.
- **Auth Files**: upload/download/delete JSON credentials, filter/search/pagination, runtime-only indicators, view supported models per credential (when the server supports it), manage OAuth excluded models (supports `*` wildcards), configure OAuth model alias mappings.
- **OAuth**: start OAuth/device flows for supported providers, poll status, optionally submit callback `redirect_url`; includes iFlow cookie import.
- **Quota Management**: manage quota limits and usage for Claude, Antigravity, Codex, Gemini CLI, and other providers.
- **Usage**: requests/tokens charts (hour/day), per-API & per-model breakdown, cached/reasoning token breakdown, RPM/TPM window, optional cost estimation with locally-saved model pricing, and current-auth-pool default scoping when auth-pool mode is enabled.
- **Config**: edit `/config.yaml` in-browser with YAML highlighting + search, then save/reload.
- **Logs**: tail logs with incremental polling, auto-refresh, search, hide management traffic, clear logs; download request error log files.
- **System**: quick links + fetch `/v1/models` (grouped view). Requires at least one proxy API key to query models.

## Tech Stack

- React 19 + TypeScript 5.9
- Vite 7 (single-file build)
- Zustand (state management)
- Axios (HTTP client)
- react-router-dom v7 (HashRouter)
- Chart.js (data visualization)
- CodeMirror 6 (YAML editor)
- SCSS Modules (styling)
- i18next (internationalization)

## Internationalization

Currently supports three languages:

- English (en)
- Simplified Chinese (zh-CN)
- Russian (ru)

The UI language is automatically detected from browser settings and can be manually switched at the bottom of the page.

## Browser Compatibility

- Build target: `ES2020`
- Supports modern browsers (Chrome, Firefox, Safari, Edge)
- Responsive layout for mobile and tablet access

## Build & release notes

- Vite produces a **single HTML** output (`dist/index.html`) with all assets inlined (via `vite-plugin-singlefile`).
- Tagging `vX.Y.Z` triggers `.github/workflows/release.yml` to publish `dist/management.html`.
- Desktop packaging typically copies or renames the built `dist/index.html` to `management.html` during release/publish.
- The build injects a local management build marker so CLI Proxy API can recognize a locally published management page and avoid replacing it with a downloaded fallback asset.
- The UI version shown in the footer is injected at build time (env `VERSION`, git tag, or `package.json` fallback).

## Versioning

See [VERSIONING.md](VERSIONING.md). The UI version is managed through the repository `VERSION` file, should stay aligned with `package.json`, and should move in lockstep with the backend fork major version.

Architecture details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Security notes

- The management key is stored in browser `localStorage` using a lightweight obfuscation format (`enc::v1::...`) to avoid plaintext storage; treat it as sensitive.
- Use a dedicated browser profile/device for management. Be cautious when enabling remote management and evaluate its exposure surface.

## Troubleshooting

- **Can’t connect / 401**: confirm the API address and management key; remote access may require enabling remote management in the server config.
- **Repeated auth failures**: the server may temporarily block remote IPs.
- **Logs page missing**: enable “Logging to file” in Basic Settings; the navigation item is shown only when file logging is enabled.
- **Some features show “unsupported”**: the backend may be too old or the endpoint is disabled/absent (common for model lists per auth file, excluded models, logs).
- **OpenAI provider test fails**: the test runs in the browser and depends on network/CORS of the provider endpoint; a failure here does not always mean the server cannot reach it.

## Development

```bash
npm run dev        # Vite dev server
npm run build      # tsc + Vite build
npm run preview    # serve dist locally
npm run lint       # ESLint (fails on warnings)
npm run format     # Prettier
npm run type-check # tsc --noEmit
```

## Contributing

Issues and PRs are welcome. Please include:

- Reproduction steps (server version + UI version)
- Screenshots for UI changes
- Verification notes (`npm run lint`, `npm run type-check`)

## License

MIT
