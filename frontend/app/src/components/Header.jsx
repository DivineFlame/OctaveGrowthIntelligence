import React from 'react';
import { Crown } from 'lucide-react';

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function Header({ tenantName, userName, premium }) {
  return (
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <img src="/octave-logo.png" alt="" className="h-6 w-6 rounded" />
          <span className="text-[15px] font-bold tracking-[-0.02em] text-zinc-900 dark:text-white">Octave</span>
          {premium ? (
            <span className="flex items-center gap-1 rounded-full bg-gradient-to-r from-[#FFD700]/15 to-[#FFA500]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-[#0a7a62] dark:text-[#FFD700]">
              <Crown className="h-3 w-3" />
              V4 Premium
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-[20px] font-bold text-zinc-900 dark:text-white">
          {greeting()}, {userName || 'there'}
        </p>
        <p className="text-[12px] text-zinc-500 dark:text-white/50">Your tenant: {tenantName || '—'}</p>
      </div>
    </header>
  );
}
