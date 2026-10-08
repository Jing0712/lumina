/**
 * The browser talks to the gateway directly (NEXT_PUBLIC_API_URL), exactly like the
 * provided web/: the answer stream must not pass through a second proxy that could buffer it.
 *
 * One rewrite: /evals/report.json on this origin is the gateway's report, so the
 * "machine-readable" link on /evals works from the submitted URL too.
 */
const gateway = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@lumina/contract'],
  poweredByHeader: false,
  async rewrites() {
    return gateway ? [{ source: '/evals/report.json', destination: `${gateway}/evals/report.json` }] : [];
  }
};

export default nextConfig;
