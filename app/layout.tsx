import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fund Analyzer",
  description:
    "Look through any US or Canadian fund to the securities it actually holds.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
