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
        // The unguessable tracker URL is the only credential — don't leak it via the Referer header
        // when a customer clicks an outbound link from the page.
        source: "/t/:path*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
