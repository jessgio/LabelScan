# Label Scanner

Warehouse barcode scanner for shipping throughput. The same app deploys twice:

| | Aeris | FTI (From This Island) |
| --- | --- | --- |
| Vercel project | `label-scan` | `fti-label-scan` |
| Supabase project | `aeris-label-scan` | `fti-label-scan` |
| Sign-in domain | `@aerisbeaute.com` | `@fromthisisland.com` |
| Region | Mumbai | Singapore |

Brand, timezone, and the allowed email domain come from `NEXT_PUBLIC_*` variables. Defaults match Aeris, so that deployment does not need new variables. See `.env.example`.

The FTI database schema lives in `supabase/fti/0001_init.sql`. Do not apply that file to the Aeris project; it restricts sign-up to `@fromthisisland.com`.

## Local development

```bash
cp .env.example .env.local
npm install
npm run dev
```

## Daily report

Vercel cron calls `GET /api/daily-report` at 19:00 UTC (02:00 Jakarta). The route requires `Authorization: Bearer $CRON_SECRET`. A run in the first hours after local midnight reports the warehouse day that just ended, using absolute Jakarta instants. The database session is UTC, so date filters must not be bare `YYYY-MM-DD` strings.

FTI has no service-role key in the app. The cron calls `get_daily_metrics`, which checks `CRON_SECRET` against the `cron_secret` value in Supabase Vault. Aeris keeps using `SUPABASE_SERVICE_ROLE_KEY` when that variable is set.
