# Versioning

This UI repository follows the backend fork version.

## Source of truth

- Management UI version: `VERSION`
- `package.json` version should stay aligned with `VERSION`
- The footer and System page read the build-time `__APP_VERSION__` value generated from `VERSION`

## Release format

- Stable release tag: `vX.Y.Z`
- Optional pre-release tag: `vX.Y.Z-rc.N`

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
6. When you want the update checker to prefer GitHub releases, create a matching Git tag and release such as `v1.1.1`
