import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RecruitCRM AI Analytics",
  description: "Conversational analytics platform for recruitment data",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased selection:bg-indigo-500/30">
        {children}
      </body>
    </html>
  );
}