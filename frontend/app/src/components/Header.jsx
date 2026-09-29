import React from 'react';
import { companyLogoUrl } from '../lib/api.js';

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function Header({ companyName, userName }) {
  // Shows this company's own uploaded logo (Company Settings, Admin-only)
  // when one exists, falling back to Octave's default mark otherwise -
  // same pattern as overlay.html's top bar/sign-in screen. Octave's own
  // branding still always appears separately, in the "Powered by
  // OctaveAIAutomation" badge (overlay.html), regardless of this.
  const logoSrc = companyLogoUrl() || '/octave-logo.png';
  return (
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <img
            src={logoSrc}
            alt=""
            className="h-6 w-6 rounded"
            onError={(e) => {
              e.currentTarget.onerror = null;
              e.currentTarget.src = '/octave-logo.png';
            }}
          />
          <span className="text-[15px] font-bold tracking-[-0.02em] text-zinc-900 dark:text-white">
            {companyName || 'Octave'}
          </span>
        </div>
        <p className="mt-1 text-[20px] font-bold text-zinc-900 dark:text-white">
          {greeting()}, {userName || 'there'}
        </p>
        <p className="text-[12px] text-zinc-500 dark:text-white/50">Your company: {companyName || '—'}</p>
      </div>
    </header>
  );
}
