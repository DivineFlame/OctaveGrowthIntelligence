import React from 'react';
import { Home, Inbox, Palette, Users } from 'lucide-react';

const TABS = [
  { key: 'home', label: 'Home', icon: Home },
  { key: 'inbox', label: 'Inbox', icon: Inbox },
  { key: 'studio', label: 'Studio', icon: Palette },
  { key: 'leads', label: 'Leads', icon: Users },
];

// The "top nav bar" the product spec asks for: Home/Inbox/Studio/Leads
// tabs, plus - for the three product-scoped tabs - a product picker right
// next to them, since Inbox/Studio/Leads all need to know which product's
// channels/content/leads they're looking at. Home has no product picker;
// it's the company-wide dashboard.
export default function Nav({ active, onChange, products, selectedProductId, onSelectProduct }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-3 border-b border-black/5 pb-3 dark:border-white/[0.08]">
      <nav className="flex items-center gap-1">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = active === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => onChange(tab.key)}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors
                ${isActive
                  ? 'bg-brand text-white'
                  : 'text-zinc-600 hover:bg-zinc-100 dark:text-white/70 dark:hover:bg-white/[0.06]'}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          );
        })}
      </nav>

      {active !== 'home' && products.length > 0 ? (
        <select
          value={selectedProductId || ''}
          onChange={(e) => onSelectProduct(e.target.value)}
          aria-label="Product"
          className="ml-auto rounded-full border border-black/10 bg-transparent px-3 py-1.5 text-[12px] text-zinc-700 outline-none focus:border-brand dark:border-white/15 dark:text-white/80"
        >
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
