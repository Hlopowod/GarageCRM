# Hostinger Web Deployment

Target setup:

- `https://crmgarage.co.uk/` stays on WordPress.
- `https://app.crmgarage.co.uk/` runs the Garage CRM web app.
- Supabase remains the database, auth provider, and Edge Function backend.

## 1. Create The Subdomain

In Hostinger hPanel:

1. Open Websites.
2. Add a new website.
3. Enter `app.crmgarage.co.uk`.
4. Choose Node.js Web App if available on the current plan.

Use the subdomain as an independent website. This keeps the WordPress site and CRM app separated.

## 2. Deploy From Source

Upload `release-assets/hostinger/garage-crm-hostinger-source-*.zip`, or connect the GitHub repository once the source code is pushed.

Recommended Hostinger build settings:

- Install command: `npm ci`
- Build command: `npm run build`
- Output directory: `dist`

If Hostinger asks for the framework, choose Vite, React/Vite, or Other with the settings above.

## 3. Environment Variables

Set these in Hostinger for the `app.crmgarage.co.uk` app:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
VITE_AUTH_REDIRECT_URL=https://app.crmgarage.co.uk/
VITE_PASSWORD_RESET_REDIRECT_URL=https://app.crmgarage.co.uk/
```

Use `hostinger.env.example` as the copy source.

## 4. Supabase Redirect URLs

In Supabase Dashboard -> Authentication -> URL Configuration:

- Site URL: `https://app.crmgarage.co.uk/`
- Redirect URLs:
  - `https://app.crmgarage.co.uk/`
  - `https://app.crmgarage.co.uk/*`
  - `garagecrm://auth/callback` if the desktop app should keep handling password reset links too.

## 5. Supabase Database

Run `supabase/schema.sql` in the Supabase SQL Editor if it has not already been applied.

The web app uses `garage_account_snapshots` for the online workspace. That table has owner-only RLS policies, so each logged-in user can read and update only their own CRM snapshot.

## 6. Rebuild A Hostinger ZIP

Run:

```powershell
npm run hostinger:package
```

This creates:

- `release-assets/hostinger/garage-crm-hostinger-source-<stamp>.zip`
- `release-assets/hostinger/garage-crm-web-dist-<stamp>.zip`

The packages do not include `.env`, updater keys, release assets, `node_modules`, or Tauri build output.

## 7. Update Flow

Future release flow:

1. Update the app version with `npm run release:prepare -- <version>`.
2. Build/publish Windows through GitHub Actions.
3. Build/publish Android from the same source tree.
4. Redeploy the Hostinger web app from GitHub or upload a fresh Hostinger ZIP.

The web app updates as soon as Hostinger redeploys. Windows updates use the Tauri updater. Android updates should go through Google Play for automatic updates.
