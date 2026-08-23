import type { Metadata } from 'next';
import { Noto_Serif_SC, Noto_Sans_SC } from 'next/font/google';
import './globals.css';
import NavBar from '../components/nav-bar';

export const metadata: Metadata = {
  title: 'Kittilsen Best Friend',
  description: '懂你的老朋友',
};

// 旧档案馆设计系统：标题衬线（宋）+ 正文黑体；next/font 构建时自托管，运行时不外联
const serif = Noto_Serif_SC({ weight: ['400', '700'], subsets: ['latin'], variable: '--font-serif' });
const sans = Noto_Sans_SC({ weight: ['400', '500'], subsets: ['latin'], variable: '--font-sans' });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={`${serif.variable} ${sans.variable}`}>
      <body>
        <NavBar />
        {children}
      </body>
    </html>
  );
}
