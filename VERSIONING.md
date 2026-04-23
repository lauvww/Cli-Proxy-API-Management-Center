# Versioning

This UI repository follows the backend fork version.

## Source of truth

- Management UI version: `VERSION`
- `package.json` version should stay aligned with `VERSION`
- The footer and System page read the build-time `__APP_VERSION__` value generated from `VERSION`

## Release format

- Stable release tag: `vX.Y.Z`
- Optional pre-release tag: `vX.Y.Z-rc.N`
- The current coordinated major line is `2.x`
- The management UI should follow the backend fork major version unless a release note explicitly documents a compatibility exception

## Build behavior

- Vite uses `VERSION` first
- If `VERSION` is missing, the build falls back to git tags, then `package.json`
- The generated single-file output is `dist/index.html`
- Desktop packaging publishes that file as `management.html`

## Recommended workflow

1. Update `VERSION`
2. Update `package.json` version to the same value
3. Commit the version bump
4. Run `npm run build`
5. Publish `management.html`
6. When you want the update checker to prefer GitHub releases, create a matching Git tag and release such as `v2.2.1`

## Notes

- For coordinated releases, update the backend `VERSION`, frontend `VERSION`, and frontend `package.json` together.
- The Config page now depends on runtime metadata returned by the backend for features such as remote model catalog refresh overrides and live auth-index mapping, so documentation and release notes should assume matched backend and UI versions.
- The current coordinated stable line is `2.2.1`, which reflects the multi-auth-pool runtime, watcher hot-apply behavior, and the current `/v1/models` global-registry-view semantics used by the UI.
