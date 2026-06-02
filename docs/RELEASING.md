# Releasing Garage CRM

## One-time GitHub setup

Add these repository settings in `Hlopowod/GarageCRM`:

- Repository secret: `TAURI_SIGNING_PRIVATE_KEY`
- Repository secret: `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (optional, can be empty)
- Repository secret: `GARAGE_CRM_UPDATER_PUBKEY`

The public updater key is not sensitive, but storing it as a GitHub Secret is the easiest way to preserve its multiline format.
The private signing key must stay in GitHub Secrets only.

The release workflow already uses this updater endpoint:

`https://github.com/Hlopowod/GarageCRM/releases/latest/download/latest.json`

## One-time local key generation

Run:

```powershell
npm run tauri signer generate -- -w "$env:USERPROFILE\.tauri\garage-crm.key"
```

Save:

- the private key content or file into GitHub secret `TAURI_SIGNING_PRIVATE_KEY`
- the public key content into GitHub secret `GARAGE_CRM_UPDATER_PUBKEY`

## Preparing a new version

Run:

```powershell
npm run release:prepare -- 1.0.1
```

This updates:

- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

## Publishing

Current active workflow:

1. Build or upload the Windows EXE/MSI assets to a GitHub Release.
2. Open GitHub Actions.
3. Run workflow `Sign Uploaded Release`.
4. Enter the version without `v`, for example `1.0.1`.

That workflow signs the uploaded Windows assets, uploads `.sig` files, publishes `latest.json`, and marks the release as latest.

The full build-and-release workflow is kept as a disabled template at `docs/release-workflow.disabled.yml`. Re-enable it only after validating it in GitHub Actions.

## Important GitHub setting

If the workflow cannot create releases, open:

`Settings -> Actions -> General -> Workflow permissions`

and enable:

`Read and write permissions`
