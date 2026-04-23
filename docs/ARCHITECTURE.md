# Management Center Architecture

This document describes the current frontend architecture as implemented in the local `2.2.1` codebase.

## Application Shape

The Management Center is a single-page React application that talks to the backend Management API and selected public endpoints such as `/v1/models`.

Core characteristics:

- single-page UI
- HashRouter navigation
- single-file production build (`dist/index.html`)
- desktop-friendly deployment as `management.html`

## Main Layers

### 1. API Layer

`src/services/api/*`

This layer wraps:

- management config APIs
- auth pool APIs
- auth files APIs
- usage APIs
- model discovery APIs
- provider-specific management actions

It is intentionally thin and mostly transport-focused.

### 2. State Layer

The UI uses Zustand for cross-page state:

- auth connection state
- current config snapshot
- model list state
- usage stats state
- notifications
- theme

Important stores and hooks:

- `src/stores/useModelsStore.ts`
- `src/stores/useUsageStatsStore.ts`
- `src/hooks/useVisualConfig.ts`
- `src/components/usage/hooks/useUsageData.ts`

### 3. Page Layer

Key pages for the current codebase:

- `ConfigPage`
- `AuthPoolPage`
- `AuthFilesPage`
- `UsagePage`
- `SystemPage`
- `DashboardPage`

These pages should share stores and helpers instead of each implementing their own transport logic.

## Models Flow

Current model discovery flow:

1. page asks `useModelsStore.fetchModels(...)`
2. store collects configured API keys
3. store tries `/v1/models` with multiple keys in order
4. first successful response wins
5. store caches by:
   - api base
   - API key scope set
6. store keeps backend-reported models scope metadata

Current backend contract:

- `/v1/models` is treated as a **global registry view**
- frontend should present the result as a global view, not as a guaranteed per-key execution view

This unified fallback path is shared by:

- `SystemPage`
- `DashboardPage`
- `UsagePage`

## Config Editing Flow

The config page uses a source-first approach with an optional visual layer.

### Source mode

- edits raw YAML
- preserves file intent and comments more reliably
- preferred for correctness-sensitive edits

### Visual mode

- derives structured fields from YAML
- applies targeted edits back onto the current YAML document
- avoids replacing the entire file structure where possible

Current architecture:

- `ConfigPage` orchestrates load/save/diff flow
- `useVisualConfig` owns structured parsing and serialization helpers
- `VisualConfigEditor` renders grouped form sections

Recent stability work focuses on:

- reducing repeated `fetchConfigYaml + fetchConfig`
- avoiding unnecessary full YAML parse/serialize cycles
- keeping source mode smooth and predictable

## Auth Pool UI Semantics

The frontend distinguishes several concepts that used to get mixed together:

- current runtime/fallback pool
- viewed pool
- configured pool list

Pages involved:

- `AuthPoolPage`
  - switch/view pool
  - show current routing strategy
  - show runtime file list for the viewed pool

- `AuthFilesPage`
  - works on the current/view scope reported by backend

- `UsagePage`
  - supports pool-based filtering
  - uses backend-provided scope hints

Shared path logic lives in:

- `src/utils/authPool.ts`

## Usage Architecture

`UsagePage` currently uses a page-level main source:

- `useUsageData(...)`

From that main usage snapshot, the page derives:

- stat cards
- request/token charts
- API detail breakdown
- model breakdown
- request event rows
- service health

Helpers live in:

- `src/utils/usage.ts`
- `src/utils/sourceResolver.ts`

The design goal is:

- one page-level usage source
- shared derived logic
- consistent updates on:
  - auto refresh
  - manual refresh
  - alias changes
  - time-range changes
  - pool filter changes

## Request Event Display

Request event display resolves source labels through:

- configured API keys
- configured API key aliases
- provider config entries
- auth file map fallback

This keeps request detail labels aligned with API key alias semantics instead of introducing a separate hardcoded naming system.

## Tech Stack

- React 19
- TypeScript 5.9
- Vite 7
- Zustand
- Axios
- Chart.js
- CodeMirror 6
- SCSS Modules
- i18next

## Build and Deployment

Development:

- `npm run dev`
- `npm run type-check`
- `npm run build`

Production artifact:

- `dist/index.html`

Desktop/runtime publish target:

- `management.html`

## Version Line

Current coordinated frontend version: `2.2.1`
