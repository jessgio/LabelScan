import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { brandDescription, brandName } from "@/lib/brand";
import "./globals.css";

const brandColor = process.env.NEXT_PUBLIC_BRAND_COLOR || "#4f46e5";
const brandColorDark = process.env.NEXT_PUBLIC_BRAND_COLOR_DARK || "#4338ca";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: brandName,
  description: brandDescription,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: brandColor,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      style={{ ["--brand" as string]: brandColor, ["--brand-dark" as string]: brandColorDark }}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
