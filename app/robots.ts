import type { MetadataRoute } from "next";

/**
 * Serves /robots.txt (IAI-314).
 *
 * We deliberately do NOT `Disallow: /t/` or `/tracker`. The tracker pages carry a `noindex`
 * directive (both the <meta robots> tag in app/layout.tsx and the X-Robots-Tag header in
 * next.config.ts). Blocking crawlers here would PREVENT them from ever seeing that directive — and
 * Google can still index a blocked URL if it's linked publicly (a URL-only listing). Correct
 * posture: let crawlers fetch the pages and honor `noindex`. (`/t/{token}` is a 302 to `/tracker`,
 * which 404s without the session cookie — a crawler never gets content anyway.) We only keep bots
 * out of the API.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/api/",
    },
  };
}
