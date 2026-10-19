import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Belt-and-suspenders over the <meta robots> tag (app/layout.tsx): an HTTP-level noindex
        // covers non-HTML responses and any crawler that skips HTML parsing. Applied to all routes.
        source: "/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        // The unguessable tracker URL is the only credential — don't leak it via the Referer header.
        // `/t/*` is now a 302 to `/tracker` (token lives in an httpOnly cookie), so the page itself
        // carries no credential, but keep both covered: belt and braces for any outbound click.
        source: "/t/:path*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      {
        source: "/tracker",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
