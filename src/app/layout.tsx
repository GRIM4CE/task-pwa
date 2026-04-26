import type { Metadata, Viewport } from "next";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Todo",
  description: "Shared household todo list",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Todo",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#e8edf7",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <head>
        <link rel="apple-touch-icon-precomposed" href="/icons/apple-touch-icon.png" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
      </head>
      <body className="min-h-full bg-app text-text antialiased font-sans">
        <ServiceWorkerRegistrar />
        {children}
      </body>
    </html>
  );
}
