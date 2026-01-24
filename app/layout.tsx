import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Constellation - HPC Orchestration Dashboard",
  description: "High-Performance Computing pipeline orchestration and monitoring",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
