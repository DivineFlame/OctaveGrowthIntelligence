import React from 'react';

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function Header({ companyName, userName }) {
  return (
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <img src="/octave-logo.png" alt="" className="h-6 w-6 rounded" />
          <span className="text-[15px] font-bold tracking-[-0.02em] text-zinc-900 dark:text-white">Octave</span>
        </div>
        <p className="mt-1 text-[20px] font-bold text-zinc-900 dark:text-white">
          {greeting()}, {userName || 'there'}
        </p>
        <p className="text-[12px] text-zinc-500 dark:text-white/50">Your company: {companyName || '—'}</p>
      </div>
    </header>
  );
}
