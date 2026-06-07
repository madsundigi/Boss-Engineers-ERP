# Boss Engineers ERP — Desktop (macOS .dmg)

An Electron shell around the React SPA in `../web`. It renders the full ERP UI in
a native window and talks to the ERP API over HTTP (base URL is set on the login
screen, default `http://localhost:3001`).

## Build the .dmg

```bash
cd desktop
npm install            # electron + electron-builder (one-time)
npm run dist           # builds web -> syncs renderer -> packages the DMG
```

Output: `release/Boss Engineers ERP-<version>-<arch>.dmg` (arm64 on Apple
Silicon, x64 on Intel). The build is **unsigned** (`mac.identity: null`), so on
first launch use Finder → right-click → Open (or System Settings → Privacy &
Security → Open Anyway) to bypass Gatekeeper. Add an Apple Developer ID and set
`CSC_LINK`/`CSC_KEY_PASSWORD` to ship a signed + notarized build.

## Run without packaging (dev)

```bash
cd desktop && npm start      # syncs renderer then launches Electron
```

## Point it at a backend

On the login screen, click the **API: …** link to set the API base URL — your
deployed Render URL (see ../DEPLOY.md) or a local `http://localhost:3001`.
Sign in with a user that has a password set (`cd ../app && npm run set-password
<username> <password>`); e.g. `admin_user`.

## Notes

- `webSecurity` is disabled in the renderer so the `file://` UI can call the
  remote API without CORS friction — standard for a trusted desktop client.
- `release/`, `renderer/`, and `node_modules/` are git-ignored (build artifacts).
- Default Electron icon is used; drop an `.icns` at `build/icon.icns` and
  electron-builder will pick it up.
