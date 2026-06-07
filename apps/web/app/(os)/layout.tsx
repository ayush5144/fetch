import { Sidebar } from '@/components/Sidebar';

/**
 * The OS shell: a persistent sidebar beside the routed content. Every OS page
 * renders its own Topbar inside the `.main` column so titles and actions stay
 * aligned. The marketing landing at `/` lives outside this group and has no
 * sidebar.
 */
export default function OsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <Sidebar />
      <div className="main">{children}</div>
    </div>
  );
}
