import type { NextConfig } from 'next';

/**
 * Which deployment this build is for. Mirrors `appEnv()` in `src/lib/env.ts`, and the order is
 * load-bearing: Vercel builds every deployment with `NODE_ENV=production`, preview included, so
 * `NODE_ENV` is deliberately not in this chain. Falling back to it would make previews indexable.
 */
const APP_ENV = process.env.APP_ENV?.trim() || process.env.VERCEL_ENV?.trim() || 'development';
const IS_PRODUCTION = APP_ENV === 'production';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // A green deploy with a red typecheck is the failure CI exists to prevent.
  typescript: { ignoreBuildErrors: false },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // Only production may be indexed; a preview must never compete with it in search.
          ...(IS_PRODUCTION ? [] : [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }]),
        ],
      },
    ];
  },
};

export default nextConfig;
