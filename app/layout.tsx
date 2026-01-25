import type { Metadata, Viewport } from "next";
import "./globals.css";
import Providers from "./components/Providers";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://constellation.example.com";
const title = "Constellation - HPC Pipeline Orchestration";
const description =
  "Constellation is an intelligent HPC pipeline orchestration platform that uses AI to automate, optimize, and deploy high-performance computing workflows with real-time monitoring and autonomous error fixing.";
const image = `${siteUrl}/web-app-manifest-512x512.png`;

// Viewport configuration
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  themeColor: [
    {
      media: "(prefers-color-scheme: light)",
      color: "#ffffff",
    },
    {
      media: "(prefers-color-scheme: dark)",
      color: "#020410",
    },
  ],
};

export const metadata: Metadata = {
  // Basic metadata
  title: {
    default: title,
    template: "%s | Constellation",
  },
  description,
  applicationName: "Constellation",
  category: "productivity",
  keywords: [
    "HPC",
    "High-Performance Computing",
    "Pipeline Orchestration",
    "AI Automation",
    "Workflow Management",
    "Cloud Computing",
    "Data Pipeline",
  ],
  authors: [
    {
      name: "Constellation Team",
    },
  ],

  // Favicon and icons
  icons: {
    icon: [
      {
        url: "/favicon.ico",
        sizes: "any",
      },
      {
        url: "/web-app-manifest-192x192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        url: "/web-app-manifest-512x512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
    apple: "/web-app-manifest-192x192.png",
  },

  // Open Graph (Social Media Sharing)
  openGraph: {
    type: "website",
    url: siteUrl,
    title,
    description,
    images: [
      {
        url: image,
        width: 512,
        height: 512,
        alt: "Constellation HPC Orchestration Platform",
        type: "image/png",
      },
      {
        url: `${siteUrl}/web-app-manifest-192x192.png`,
        width: 192,
        height: 192,
        alt: "Constellation Logo",
        type: "image/png",
      },
    ],
    siteName: "Constellation",
  },

  // Twitter Card
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [image],
  },

  // Web App Meta Tags
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Constellation",
  },
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },

  // Additional SEO
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },

  // Verification and alternate
  alternates: {
    canonical: siteUrl,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        {/* Preconnect to external domains for performance */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        
        {/* Web App Manifest */}
        <link rel="manifest" href="/manifest.json" />
        
        {/* Theme color for mobile browsers */}
        <meta name="theme-color" content="#020410" media="(prefers-color-scheme: dark)" />
        <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
        
        {/* Mobile optimization */}
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
