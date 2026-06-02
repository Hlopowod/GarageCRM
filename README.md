# Garage CRM — Tauri Desktop App

Full garage management system: clients, vehicles, job cards, invoices, bookings.
Data stored locally in SQLite. Runs on macOS and Windows.

## Prerequisites

**Both platforms:**
- Rust + Cargo: https://rustup.rs
- Node.js 18+: https://nodejs.org

**macOS only** (if not already installed):
```
xcode-select --install
```

**Windows only** (if not already installed):
- Microsoft C++ Build Tools: https://visualstudio.microsoft.com/visual-cpp-build-tools/
  - During install, select "Desktop development with C++"
- WebView2 (usually pre-installed on Windows 10/11)

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy cloud config template once
copy .env.example .env

# 3. Run in development mode (hot reload)
npm run tauri dev

# 4. Build production installer
npm run tauri build
```

The dev build opens the app window automatically.
The production build creates an installer in `src-tauri/target/release/bundle/`.

## Features

- **Dashboard** — live stats: cars in service, open jobs, unpaid invoices, revenue
- **Clients** — full CRM with contact info, vehicle list, work history, balance
- **Vehicles** — fleet overview, MOT due dates, service history
- **Job Cards** — create/edit jobs, add labour/parts lines, auto-calculate VAT, generate invoices
- **Invoices** — view, mark as paid, track outstanding amounts
- **Calendar** — weekly booking view, manage appointments

## Database

SQLite database is stored in the app data directory for your OS.
The app starts with an empty database and stores only the records you create.

## Cloud Sync

The app can sync one whole garage dataset per signed-in app account using your shared Supabase project.

Setup:

```bash
copy .env.example .env
```

Then edit `.env` with:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
# Optional. Leave empty to use the Supabase Auth Site URL.
VITE_AUTH_REDIRECT_URL=
# Password recovery opens the installed Tauri app instead of the Supabase Site URL.
VITE_PASSWORD_RESET_REDIRECT_URL=garagecrm://auth/callback
```

Run the SQL from `supabase/schema.sql` once in your Supabase SQL Editor.

Auth emails are sent by Supabase Auth. To use Resend, configure Resend as Supabase Custom SMTP in the Supabase dashboard; do not add a Resend key to this app.

For password recovery, add `garagecrm://auth/callback` in Supabase Dashboard -> Authentication -> URL Configuration -> Redirect URLs. Without that allow-list entry, Supabase falls back to the project Site URL or rejects the reset redirect.

For first-time email confirmation, edit the Supabase `Confirm signup` email template to show the OTP token instead of only a link:

```html
<h2>Garage CRM verification code</h2>
<p>Your verification code is:</p>
<h1>{{ .Token }}</h1>
<p>Enter this code in Garage CRM.</p>
```

After that, open `Settings -> Cloud Account` inside the app and create/sign in to the garage owner's account.

## App Updates

The project is prepared for in-app update checks from `Settings -> Application Updates`.

Setup once:

```powershell
npm run tauri signer generate -- -w "$env:USERPROFILE\.tauri\garage-crm.key"
```

Add these values to `.env` or `.env.local`:

```env
GARAGE_CRM_UPDATER_ENDPOINT=https://github.com/Hlopowod/GarageCRM/releases/latest/download/latest.json
GARAGE_CRM_UPDATER_PUBKEY_PATH=C:\path\to\garage-crm-updater.pub
```

`GARAGE_CRM_UPDATER_PUBKEY_PATH` should point to a text file that contains the updater public key. If you prefer, you can store the key inline with `GARAGE_CRM_UPDATER_PUBKEY=...` instead.

Before building a release, set the signing key for Tauri:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY="$env:USERPROFILE\.tauri\garage-crm.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build
```

`tauri build` will now generate updater artifacts because `createUpdaterArtifacts` is enabled in `src-tauri/tauri.conf.json`.

After you upload the generated installer, its `.sig` file, and the `latest.json` manifest to your release host, the installed app can detect the newer version in Settings and offer the update to the user.

For GitHub-based releases in `Hlopowod/GarageCRM`, use the ready workflow in `.github/workflows/release.yml` and the guide in `docs/RELEASING.md`.

## Troubleshooting

**"cargo not found"** → Install Rust: https://rustup.rs then restart terminal

**Windows build fails** → Make sure C++ Build Tools are installed with "Desktop development with C++" workload

**"tauri not found"** → Run `npm install` first, then `npm run tauri dev`
