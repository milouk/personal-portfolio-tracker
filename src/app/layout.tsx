import type { Metadata } from "next";
import { Onest, JetBrains_Mono, Fraunces } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PrivacyProvider } from "@/components/privacy-provider";
import "./globals.css";

const sans = Onest({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const display = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Portfolio · Personal Net Worth Tracker",
  description: "A sexy, dynamic tracker for your personal financial position.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sans.variable} ${mono.variable} ${display.variable} h-full`}
    >
      <body className="min-h-full antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <PrivacyProvider>
            <TooltipProvider delayDuration={150}>
              {children}
              <Toaster richColors position="bottom-right" />
            </TooltipProvider>
          </PrivacyProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
