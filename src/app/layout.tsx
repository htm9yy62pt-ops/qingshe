import type { Metadata } from "next";
import "./globals.css";
import Navigation from "@/components/navigation";

export const metadata: Metadata = {
  title: "轻舍 Qingshe",
  description: "AI 现实生活入口",
};

export default function RootLayout({ 
  children 
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <div className="flex-1 flex flex-col pb-16">
          {children}
        </div>
        <Navigation />
      </body>
    </html>
  );
}
