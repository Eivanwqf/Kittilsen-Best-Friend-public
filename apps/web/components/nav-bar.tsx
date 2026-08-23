// 墨色顶栏导航（client：usePathname 高亮当前页）
'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/', label: '图书馆' },
  { href: '/timeline', label: '时间线' },
  { href: '/chat', label: '对话' },
  { href: '/settings', label: '设置' },
];

export default function NavBar() {
  const pathname = usePathname();
  const active = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <nav className="topbar">
      <div className="topbar-inner">
        <Link href="/" className="topbar-brand">
          <img
            src="/icon.png"
            alt="KBF"
            style={{ width: 26, height: 26, borderRadius: 5, boxShadow: 'inset 0 0 0 1px rgba(253,251,244,0.45)' }}
          />
          Kittilsen Best Friend
        </Link>
        <div className="topbar-nav">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={`topbar-link${active(n.href) ? ' active' : ''}`}>
              {n.label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
