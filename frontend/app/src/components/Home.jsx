import React from 'react';
import { Package } from 'lucide-react';

// The company-wide dashboard (the original spec's "Home is for Tenant
// (Company) Dashboard" - "tenant" here meaning this app's single company,
// see README.md "Hardening notes" on removing multi-tenancy). Shows the
// company itself and every product in it, not one product's detail -
// that's what Inbox/Studio/Leads are for, each scoped to a product picked
// from the top nav.
export default function Home({ company, products, totalLeads, onOpenProduct }) {
  return (
    <div className="space-y-5">
      <section className="rounded-[16px] border border-black/5 bg-white p-5 dark:border-white/[0.08] dark:bg-[#0f0f10]/90">
        <div>
          <h2 className="text-[16px] font-bold text-zinc-900 dark:text-white">{company ? company.name : 'Your company'}</h2>
          <p className="text-[12px] text-zinc-500 dark:text-white/50">
            {products.length} product{products.length === 1 ? '' : 's'} · {totalLeads} lead{totalLeads === 1 ? '' : 's'} total
          </p>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-widest text-zinc-500 dark:text-white/50">Products</h3>
        {products.length ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((p) => (
              <button
                key={p.id}
                onClick={() => onOpenProduct(p.id)}
                className="flex flex-col items-start gap-1.5 rounded-[12px] border border-black/5 bg-white p-4 text-left transition-colors hover:border-brand/50 dark:border-white/[0.08] dark:bg-[#121214]"
              >
                <div className="flex items-center gap-2 text-brand">
                  <Package className="h-4 w-4" />
                  <span className="text-[13px] font-semibold text-zinc-900 dark:text-white">{p.name}</span>
                </div>
                <p className="line-clamp-2 text-[12px] text-zinc-500 dark:text-white/50">{p.description || 'No description'}</p>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-[12px] border border-black/5 bg-white p-6 text-center text-[13px] text-zinc-500 dark:border-white/[0.08] dark:bg-[#121214] dark:text-white/50">
            No products yet — create one from Admin &gt; Products to get started.
          </div>
        )}
      </section>
    </div>
  );
}
