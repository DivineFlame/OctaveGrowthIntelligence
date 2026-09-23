import React, { useEffect, useMemo, useState } from 'react';
import Header from './components/Header.jsx';
import StatTiles from './components/StatTiles.jsx';
import ContentPipeline from './components/ContentPipeline.jsx';
import IntegrationsPanel from './components/IntegrationsPanel.jsx';
import { api, currentUser, ApiError } from './lib/api.js';

const APPROVER_ROLES = ['SUPER_ADMIN', 'APPROVER', 'DEPT_ADMIN', 'IT_ADMIN'];
const INTEGRATIONS_ROLES = ['SUPER_ADMIN', 'IT_ADMIN'];

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

export default function App() {
  const session = currentUser();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [products, setProducts] = useState([]);
  const [selectedProductId, setSelectedProductId] = useState(null);
  const [assets, setAssets] = useState([]);
  const [spec, setSpec] = useState({});
  const [channels, setChannels] = useState([]);
  const [leads, setLeads] = useState([]);
  const [integrations, setIntegrations] = useState([]);

  const role = session && session.user ? session.user.role : null;
  const canApprove = role ? APPROVER_ROLES.includes(role) : false;
  const canSeeIntegrations = role ? INTEGRATIONS_ROLES.includes(role) : false;

  useEffect(() => {
    // Not signed in yet (the auth gate in overlay.html owns that flow) -
    // nothing for this app to render or fetch until it is.
    if (!session || !session.token) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const [productList, channelSpec, leadList] = await Promise.all([
          api.products(),
          api.channelSpec(),
          api.leads().catch(() => []), // non-fatal - some roles can't see leads either
        ]);
        if (cancelled) return;
        setProducts(productList);
        setSpec(channelSpec);
        setLeads(leadList);

        const firstProduct = productList[0];
        if (firstProduct) {
          setSelectedProductId(firstProduct.id);
          const [content, prodChannels] = await Promise.all([
            api.productContent(firstProduct.id),
            api.productChannels(firstProduct.id).catch(() => []),
          ]);
          if (cancelled) return;
          setAssets(content);
          setChannels(prodChannels);
        }

        if (canSeeIntegrations) {
          try {
            const { channels: integrationChannels } = await api.integrations();
            if (!cancelled) setIntegrations(integrationChannels);
          } catch {
            /* 403 for this role, or not configured - fine, panel just stays empty */
          }
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof ApiError ? e.message : 'Failed to load dashboard');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stats = useMemo(() => {
    const activeChannels = channels.filter((c) => c.status === 'configured').length;
    const totalChannels = Object.keys(spec).length;
    const transformedToday = assets.reduce(
      (sum, a) => sum + (a.variants || []).filter((v) => isToday(v.created_at)).length,
      0
    );
    return { activeChannels, totalChannels, transformedToday, leadsImported: leads.length };
  }, [channels, spec, assets, leads]);

  const handleUploaded = (asset) => setAssets((prev) => [{ ...asset, variants: [] }, ...prev]);

  const handleTransform = async (assetId, selectedChannels) => {
    await api.transformContent(assetId, selectedChannels);
    const content = await api.productContent(selectedProductId);
    setAssets(content);
  };

  const handleApprove = async (variantId, action) => {
    await api.approveVariant(variantId, action);
    const content = await api.productContent(selectedProductId);
    setAssets(content);
  };

  if (!session || !session.token) {
    // The overlay's auth gate (#oc-gate) sits on top of this and owns
    // sign-in; this app simply has nothing to show until a session exists.
    return null;
  }

  return (
    <div className="min-h-screen bg-[#fbfaf8] px-4 py-6 dark:bg-[#0a0a0b] md:px-6 md:py-7">
      <div className="mx-auto max-w-[1200px]">
        <Header
          companyName={session.company ? session.company.name : ''}
          userName={session.user ? session.user.email : ''}
          premium={!!(session.company && session.company.is_premium)}
        />

        {loading ? (
          <div className="py-10 text-center text-[13px] text-zinc-500 dark:text-white/50">Loading…</div>
        ) : loadError ? (
          <div className="rounded-[12px] border border-red-500/20 bg-red-500/10 p-4 text-[13px] text-red-600 dark:text-red-400">
            {loadError}
          </div>
        ) : (
          <div className="space-y-5">
            <StatTiles
              activeChannels={stats.activeChannels}
              totalChannels={stats.totalChannels}
              transformedToday={stats.transformedToday}
              leadsImported={stats.leadsImported}
              region={import.meta.env.VITE_REGION || 'ap-south-1'}
              storage="Paperclip media pipeline"
            />

            {selectedProductId ? (
              <div className="grid gap-4 md:grid-cols-[1.15fr_0.85fr]">
                <ContentPipeline
                  productId={selectedProductId}
                  assets={assets}
                  spec={spec}
                  canApprove={canApprove}
                  onUploaded={handleUploaded}
                  onTransform={handleTransform}
                  onApprove={handleApprove}
                />
                <IntegrationsPanel integrations={integrations} visible={canSeeIntegrations} />
              </div>
            ) : (
              <div className="rounded-[12px] border border-black/5 bg-white p-6 text-center text-[13px] text-zinc-500 dark:border-white/[0.08] dark:bg-[#121214] dark:text-white/50">
                No products yet — create one from Admin &gt; Products to start uploading content.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
