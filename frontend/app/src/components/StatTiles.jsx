import React from 'react';
import { Boxes, Languages, Sparkles, Users, Server, CircleCheck } from 'lucide-react';

const SARVAM_LANGS = ['HI', 'TA', 'TE', 'KN', 'ML', 'MR', 'GU', 'BN', 'PA', 'OR', 'AS', 'EN'];

function Tile({ icon: Icon, label, value, sub }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-[14px] border border-black/5 bg-white p-4 shadow-[0_8px_30px_rgba(0,0,0,0.04)]
                 dark:border-white/[0.08] dark:bg-[#121214] dark:shadow-none"
    >
      <div className="flex items-center gap-2 text-zinc-500 dark:text-white/50">
        <Icon className="h-4 w-4" />
        <span className="text-[11px] font-semibold uppercase tracking-widest">{label}</span>
      </div>
      <div className="text-[22px] font-bold text-zinc-900 dark:text-white">{value}</div>
      {sub ? <div className="text-[11px] text-zinc-500 dark:text-white/50">{sub}</div> : null}
    </div>
  );
}

export default function StatTiles({ activeChannels, totalChannels, transformedToday, leadsImported, region, storage }) {
  const channelHealth = totalChannels > 0 ? `${activeChannels}/${totalChannels} Connected` : 'Not configured';

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tile icon={Boxes} label="Active Channels" value={activeChannels} sub={activeChannels === totalChannels && totalChannels > 0 ? 'All synced' : channelHealth} />
      <Tile icon={Languages} label="Sarvam Langs" value={SARVAM_LANGS.length} sub={SARVAM_LANGS.slice(0, 4).join(', ') + '...'} />
      <Tile icon={Sparkles} label="Transformed Today" value={transformedToday} />
      <Tile icon={Users} label="Leads Imported" value={leadsImported} />
      <Tile icon={CircleCheck} label="Channel Health" value={channelHealth} />
      <Tile icon={Server} label="Region" value={region || '—'} sub={storage ? `Storage: ${storage}` : undefined} />
    </div>
  );
}
