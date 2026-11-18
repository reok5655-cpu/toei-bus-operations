import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "都営バス運用情報", description: "都営バスの系統・運行情報を確認できます。" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="ja"><body>{children}</body></html>; }
