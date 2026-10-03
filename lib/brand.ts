// Brand settings are build-time public env vars so one codebase can deploy
// as Aeris (defaults) or FTI (overrides on the fti-label-scan Vercel project).

export const brandName = process.env.NEXT_PUBLIC_BRAND_NAME ?? 'Label Scanner';

export const brandMark = process.env.NEXT_PUBLIC_BRAND_MARK ?? 'LS';

export const brandTagline =
  process.env.NEXT_PUBLIC_BRAND_TAGLINE ?? 'Warehouse shipping throughput';

export const allowedEmailDomain =
  process.env.NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN ?? 'aerisbeaute.com';

// Picklist order lookup is an FTI warehouse workflow. Aeris keeps the
// original scan table and does not call the picklist RPCs.
export const picklistsEnabled = allowedEmailDomain === 'fromthisisland.com';

export const brandDescription =
  'Warehouse label scanning and shipping throughput tracker.';
