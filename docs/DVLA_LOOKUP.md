# DVLA Vehicle Lookup

Garage CRM uses a Supabase Edge Function as the only place that can read the DVLA API key.
The desktop app sends a signed-in user's Supabase access token to the function, and the function:

1. checks the Supabase user session,
2. calls the DVLA Vehicle Enquiry API,
3. caches the response in `dvla_vehicle_cache`,
4. returns free DVLA fields to the app.

DVLA Vehicle Enquiry does not return the vehicle model. The app intentionally keeps `Model` empty and optional for manual entry.

## Supabase Setup

Run the SQL in `supabase/schema.sql`, then set the Edge Function secrets:

```bash
supabase secrets set DVLA_API_KEY=your_dvla_key
supabase secrets set DVLA_CACHE_TTL_DAYS=30
```

Deploy the function:

```bash
supabase functions deploy dvla-vehicle-lookup
```

`DVLA_CACHE_TTL_DAYS` is optional. If it is not set, the default cache is 30 days.
There is no daily lookup limit in this version.
