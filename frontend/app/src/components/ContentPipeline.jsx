import React, { useCallback, useRef, useState } from 'react';
import {
  Upload,
  FileVideo,
  FileText,
  FileSpreadsheet,
  Image as ImageIcon,
  Facebook,
  Instagram,
  Linkedin,
  Youtube,
  MessageCircle,
  Mail,
  Globe,
  Check,
  Clock,
} from 'lucide-react';
import StatusBadge from './StatusBadge.jsx';
import { api, ApiError } from '../lib/api.js';

const CHANNEL_ICONS = {
  whatsapp: MessageCircle,
  facebook: Facebook,
  instagram: Instagram,
  linkedin: Linkedin,
  youtube: Youtube,
  email: Mail,
  quora: Globe,
};

function fileIcon(mimeType) {
  if (!mimeType) return FileText;
  if (mimeType.startsWith('video/')) return FileVideo;
  if (mimeType.startsWith('image/')) return ImageIcon;
  if (mimeType.includes('spreadsheet') || mimeType.includes('csv')) return FileSpreadsheet;
  return FileText;
}

function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ChannelPicker({ spec, selected, onToggle }) {
  const channels = Object.entries(spec || {});
  if (!channels.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {channels.map(([key, def]) => {
        const Icon = CHANNEL_ICONS[key] || Globe;
        const isOn = selected.includes(key);
        return (
          <button
            key={key}
            type="button"
            disabled={!def.implemented}
            onClick={() => onToggle(key)}
            title={def.implemented ? undefined : `${def.label} publishing isn't implemented yet - the transform still runs, it just won't auto-publish`}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors
              ${isOn
                ? 'border-brand/50 bg-brand/10 text-brand dark:border-brand/50 dark:bg-brand/15'
                : 'border-black/10 bg-transparent text-zinc-600 hover:border-brand/60 dark:border-white/15 dark:text-white/70'}
              ${!def.implemented ? 'opacity-50' : ''}`}
          >
            <Icon className="h-3.5 w-3.5" />
            {def.label}
            {!def.implemented ? <span className="text-[9px] uppercase tracking-widest">soon</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function VariantRow({ variant, onApprove, canApprove, busy }) {
  const Icon = CHANNEL_ICONS[variant.channel] || Globe;
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-[12px] dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-500 dark:text-white/50" />
        <span className="truncate text-zinc-900 dark:text-white">{variant.title || variant.channel}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <StatusBadge status={variant.status} />
        {canApprove && variant.status === 'PENDING_APPROVAL' ? (
          <div className="flex gap-1">
            <button
              disabled={busy}
              onClick={() => onApprove(variant.id, 'APPROVE')}
              className="rounded-full bg-brand px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
            >
              Approve
            </button>
            <button
              disabled={busy}
              onClick={() => onApprove(variant.id, 'REJECT')}
              className="rounded-full bg-red-500/10 px-2.5 py-1 text-[11px] font-semibold text-red-600 disabled:opacity-50 dark:text-red-400"
            >
              Reject
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssetCard({ asset, spec, canApprove, onTransform, onApprove }) {
  const [selectedChannels, setSelectedChannels] = useState([]);
  const [transforming, setTransforming] = useState(false);
  const [approvingId, setApprovingId] = useState(null);
  const [err, setErr] = useState('');
  const Icon = fileIcon(asset.mime_type);

  const toggleChannel = (key) =>
    setSelectedChannels((prev) => (prev.includes(key) ? prev.filter((c) => c !== key) : [...prev, key]));

  const handleTransform = async () => {
    if (!selectedChannels.length) {
      setErr('Pick at least one channel first');
      return;
    }
    setErr('');
    setTransforming(true);
    try {
      await onTransform(asset.id, selectedChannels);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Transform failed');
    } finally {
      setTransforming(false);
    }
  };

  const handleApprove = async (variantId, action) => {
    setApprovingId(variantId);
    setErr('');
    try {
      await onApprove(variantId, action);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : `${action} failed`);
    } finally {
      setApprovingId(null);
    }
  };

  return (
    <div className="rounded-[12px] border border-black/5 bg-white p-4 dark:border-white/[0.08] dark:bg-[#121214]">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-zinc-500 dark:text-white/50" />
        <span className="truncate text-[13px] font-medium text-zinc-900 dark:text-white">{asset.file_name}</span>
        <span className="ml-auto shrink-0 text-[11px] text-zinc-500 dark:text-white/50">{formatBytes(asset.file_size)}</span>
      </div>

      <div className="mt-3">
        <ChannelPicker spec={spec} selected={selectedChannels} onToggle={toggleChannel} />
      </div>

      <button
        onClick={handleTransform}
        disabled={transforming}
        className="mt-3 rounded-full border border-black/10 px-3.5 py-1.5 text-[12px] font-semibold text-brand transition-colors hover:border-brand disabled:opacity-60 dark:border-white/15"
      >
        {transforming ? 'Transforming with Agent…' : 'Transform'}
      </button>

      {err ? <p className="mt-2 text-[12px] text-red-500">{err}</p> : null}

      <div className="mt-3 space-y-1.5">
        {asset.variants && asset.variants.length ? (
          asset.variants.map((v) => (
            <VariantRow key={v.id} variant={v} onApprove={handleApprove} canApprove={canApprove} busy={approvingId === v.id} />
          ))
        ) : (
          <div className="flex items-center gap-1.5 text-[12px] text-zinc-500 dark:text-white/50">
            <Clock className="h-3.5 w-3.5" />
            No variants yet
          </div>
        )}
      </div>
    </div>
  );
}

export default function ContentPipeline({ productId, assets, spec, canApprove, onUploaded, onTransform, onApprove }) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState('');
  const inputRef = useRef(null);

  const doUpload = useCallback(
    async (file) => {
      setUploading(true);
      setUploadErr('');
      try {
        const { asset } = await api.uploadContent(file, { productId });
        onUploaded(asset);
      } catch (e) {
        setUploadErr(e instanceof ApiError ? e.message : 'Upload failed');
      } finally {
        setUploading(false);
      }
    },
    [productId, onUploaded]
  );

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) doUpload(file);
  };

  return (
    <section className="rounded-[16px] border border-black/5 bg-white p-5 dark:border-white/[0.08] dark:bg-[#0f0f10]/90">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-zinc-900 dark:text-white">Content</h2>
        <div className="flex items-center gap-2 text-[11px] text-zinc-500 dark:text-white/50">
          <Check className="h-3.5 w-3.5 text-brand" />
          Paperclip media pipeline active
        </div>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current && inputRef.current.click()}
        className={`flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-[12px] border-2 border-dashed px-4 py-8 text-center transition-colors
          ${dragOver ? 'border-brand bg-brand/5' : 'border-black/10 dark:border-white/15'}`}
      >
        <Upload className="h-5 w-5 text-zinc-400 dark:text-white/40" />
        <p className="text-[13px] text-zinc-600 dark:text-white/70">
          {uploading ? 'Uploading…' : 'Drop raw video, images, script, or brand brief'}
        </p>
        <p className="text-[11px] text-zinc-400 dark:text-white/40">JPG/PNG · DOCX · MP4</p>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files && e.target.files[0];
            if (file) doUpload(file);
            e.target.value = '';
          }}
        />
      </div>
      {uploadErr ? <p className="mt-2 text-[12px] text-red-500">{uploadErr}</p> : null}

      <div className="mt-5 space-y-3">
        {assets.length ? (
          assets.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              spec={spec}
              canApprove={canApprove}
              onTransform={onTransform}
              onApprove={onApprove}
            />
          ))
        ) : (
          <div className="py-6 text-center text-[12px] text-zinc-500 dark:text-white/50">
            No content uploaded for this product yet.
          </div>
        )}
      </div>
    </section>
  );
}
