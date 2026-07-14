import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Montserrat } from "next/font/google";
import "./brand.css";

// Montserrat is the FieldPulse brand typeface, used across the whole product.
// Self-hosted by next/font; exposed as a CSS variable that app/brand.css maps
// to --fp-font-sans / --fp-font-display.
const montserrat = Montserrat({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-montserrat",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "FieldPulse Ticket Tracker",
    template: "%s · FieldPulse Ticket Tracker",
  },
  description: "Your support tickets with FieldPulse, always up to date.",
  robots: { index: false, follow: false },
  // The signal mark (app/icon.svg + app/apple-icon.png) is wired automatically
  // by the App Router file convention; it is the browser-tab favicon.
};

export const viewport: Viewport = {
  themeColor: "#00034d",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={montserrat.variable}>
      <body>{children}</body>
    </html>
  );
}
