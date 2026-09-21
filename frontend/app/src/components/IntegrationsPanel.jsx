import React from 'react';
import { Lock } from 'lucide-react';

export default function IntegrationsPanel({ integrations, visible }) {
  if (!visible) return null;

  const connected = (integrations || []).filter((i) => i.status === 'connected');

  return (
    <section className="rounded-[16px] border border-black/5 bg-white p-5 dark:border-white/[0.08] dark:bg-[#0f0f10]/90">
      <h2 className="mb-3 text-[15px] font-semibold text-zinc-900 dark:text-white">Integrations</h2>
      {connected.length ? (
        <ul className="space-y-1.5">
          {(integrations || []).map((i) => (
            <li key={i.name} className="flex items-center justify-between text-[12px]">
              <span className="capitalize text-zinc-700 dark:text-white/80">{i.name}</span>
              <span className={i.status === 'connected' ? 'text-brand' : 'text-zinc-400 dark:text-white/40'}>
                {i.status === 'connected' ? i.api_key_masked : 'Not connected'}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex items-center gap-2 text-[12px] text-zinc-500 dark:text-white/50">
          <Lock className="h-3.5 w-3.5" />
          No Slack/Drive/Notion integration is connected yet
        </div>
      )}
    </section>
  );
}
