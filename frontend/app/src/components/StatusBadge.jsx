import React from 'react';

// Mirrors the status color language already established in overlay.html's
// .oc-status-* classes (Products > Content panel), so a variant looks the
// same whether you're looking at it there or here.
const STYLES = {
  DRAFT: 'bg-zinc-100 text-zinc-600 dark:bg-white/[0.06] dark:text-white/60',
  PENDING_APPROVAL: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  APPROVED: 'bg-brand/10 text-brand dark:bg-brand/15',
  PUBLISHED: 'bg-brand/10 text-brand dark:bg-brand/15',
  REJECTED: 'bg-red-500/10 text-red-600 dark:text-red-400',
  PUBLISH_FAILED: 'bg-red-500/10 text-red-600 dark:text-red-400',
};

export default function StatusBadge({ status }) {
  const cls = STYLES[status] || STYLES.DRAFT;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${cls}`}>
      {status}
    </span>
  );
}
