import React, { useEffect, useMemo, useState } from 'react';
import Header from './components/Header.jsx';
import Nav from './components/Nav.jsx';
import Home from './components/Home.jsx';
import MessagesPanel from './components/MessagesPanel.jsx';
import ContentPipeline from './components/ContentPipeline.jsx';
import IntegrationsPanel from './components/IntegrationsPanel.jsx';
import { Package } from 'lucide-react';
import { api, currentUser, ApiError } from './lib/api.js';

const APPROVER_ROLES = ['SUPER_ADMIN', 'APPROVER', 'DEPT_ADMIN', 'IT_ADMIN'];
const INTEGRATIONS_ROLES = ['SUPER_ADMIN', 'IT_ADMIN'];

// Studio: upload + per-channel transform for one product at a time, reusing
// the existing ContentPipeline component (per the spec: "Studio is for
// uploading content on the different channel product wise, select channel
// and upload content"). The product itself is picked from Nav's product
// selector - this just loads/reloads that one product's assets+channels.
function Studio({ productId, productName, spec, canApprove, canSeeIntegrations, integrations }) {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!productId) {
      setAssets([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr('');
    api
      .productContent(productId)
      .then((content) => {
        if (!cancelled) setAssets(content);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : 'Failed to load content');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  const handleUploaded = (asset) => setAssets((prev) => [{ ...asset, variants: [] }, ...prev]);

  const handleTransform = async (assetId, selectedChannels) => {
    await api.transformContent(assetId, selectedChannels);
    const content = await api.productContent(productId);
    setAssets(content);
  };

  const handleApprove = async (variantId, action) => {
    await api.approveVariant(variantId, action);
    const content = await api.productContent(productId);
    setAssets(content);
  };

  if (!productId) {
    return (
      <div className="rounded-[12px] border border-black/5 bg-white p-6 text-center text-[13px] text-zinc-500 dark:border-white/[0.08] dark:bg-[#121214] dark:text-white/50">
        No products yet — create one from Admin &gt; Products to start uploading content.
      </div>
    );
  }

  if (loading) {
    return <div className="py-10 text-center text-[13px] text-zinc-500 dark:text-white/50">Loading…</div>;
  }

  if (err) {
    return (
      <div className="rounded-[12px] border border-red-500/20 bg-red-500/10 p-4 text-[13px] text-red-600 dark:text-red-400">
        {err}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-[12px] border border-brand/20 bg-brand/5 px-4 py-2.5 text-[13px] text-zinc-700 dark:border-brand/30 dark:bg-brand/10 dark:text-white/80">
        <Package className="h-4 w-4 shrink-0 text-brand" />
        Uploading to <span className="font-semibold text-zinc-900 dark:text-white">{productName || 'this product'}</span> — switch products using the picker in the nav bar above.
      </div>
      <div className="grid gap-4 md:grid-cols-[1.15fr_0.85fr]">
        <ContentPipeline
          productId={productId}
          assets={assets}
          spec={spec}
          canApprove={canApprove}
          onUploaded={handleUploaded}
          onTransform={handleTransform}
          onApprove={handleApprove}
        />
        <IntegrationsPanel integrations={integrations} visible={canSeeIntegrations} />
      </div>
    </div>
  );
}

export default function App() {
  const session = currentUser();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [activeTab, setActiveTab] = useState('home');
  const [company, setCompany] = useState(null);
  const [products, setProducts] = useState([]);
  const [selectedProductId, setSelectedProductId] = useState(null);
  const [spec, setSpec] = useState({});
  const [totalLeads, setTotalLeads] = useState(0);
  const [integrations, setIntegrations] = useState([]);
  const [channelList, setChannelList] = useState([]);

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
        const [companyInfo, productList, channelSpec, leadList] = await Promise.all([
          api.company().catch(() => null),
          api.products(),
          api.channelSpec(),
          api.leads().catch(() => []), // non-fatal - some roles can't see leads either
        ]);
        if (cancelled) return;
        setCompany(companyInfo);
        setProducts(productList);
        setSpec(channelSpec);
        setTotalLeads(leadList.length);

        const firstProduct = productList[0];
        if (firstProduct) setSelectedProductId(firstProduct.id);

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

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === selectedProductId) || null,
    [products, selectedProductId]
  );

  // Channel list for Inbox/Leads' left-column filter: spec gives every
  // known channel's label, productChannels gives this product's per-channel
  // configured/not_configured status - merge them so the filter always
  // shows the full channel set (spec) with this product's live status.
  useEffect(() => {
    if (!selectedProductId || !Object.keys(spec).length) {
      setChannelList([]);
      return;
    }
    let cancelled = false;
    api
      .productChannels(selectedProductId)
      .then((rows) => {
        if (cancelled) return;
        const byKey = Object.fromEntries(rows.map((r) => [r.channel, r]));
        setChannelList(
          Object.entries(spec).map(([key, def]) => ({
            key,
            label: def.label,
            status: byKey[key] ? byKey[key].status : 'not_configured',
          }))
        );
      })
      .catch(() => {
        if (!cancelled) setChannelList([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProductId, spec]);

  const handleOpenProduct = (productId) => {
    setSelectedProductId(productId);
    setActiveTab('inbox');
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
        />

        {loading ? (
          <div className="py-10 text-center text-[13px] text-zinc-500 dark:text-white/50">Loading…</div>
        ) : loadError ? (
          <div className="rounded-[12px] border border-red-500/20 bg-red-500/10 p-4 text-[13px] text-red-600 dark:text-red-400">
            {loadError}
          </div>
        ) : (
          <>
            <Nav
              active={activeTab}
              onChange={setActiveTab}
              products={products}
              selectedProductId={selectedProductId}
              onSelectProduct={setSelectedProductId}
            />

            {activeTab === 'home' ? (
              <Home company={company} products={products} totalLeads={totalLeads} onOpenProduct={handleOpenProduct} />
            ) : activeTab === 'inbox' ? (
              <MessagesPanel
                key={`inbox-${selectedProductId || 'none'}`}
                productId={selectedProductId}
                channelStatuses={channelList}
                inquiryOnly={false}
                title={selectedProduct ? `${selectedProduct.name} · Inbox` : 'Inbox'}
                subtitle="All messages across every connected channel for this product."
              />
            ) : activeTab === 'leads' ? (
              <MessagesPanel
                key={`leads-${selectedProductId || 'none'}`}
                productId={selectedProductId}
                channelStatuses={channelList}
                inquiryOnly
                title={selectedProduct ? `${selectedProduct.name} · Leads` : 'Leads'}
                subtitle="Messages Sarvam AI classified as genuine product inquiries."
              />
            ) : (
              <Studio
                productId={selectedProductId}
                productName={selectedProduct ? selectedProduct.name : ''}
                spec={spec}
                canApprove={canApprove}
                canSeeIntegrations={canSeeIntegrations}
                integrations={integrations}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
