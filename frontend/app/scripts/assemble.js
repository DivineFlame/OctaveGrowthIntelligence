#!/usr/bin/env node

// Runs after `vite build` (see package.json's "build" script). Vite builds
// this app into dist/ as plain hashed asset files (see vite.config.js for
// why - CSP-friendly, no per-build hash recomputation needed). This script
// takes those built <script>/<link> tags and splices them into the
// preserved overlay app (../overlay.html - the auth gate, admin panel,
// products/channels/onboarding/security UI, byte-for-byte unchanged from
// before this rewrite) to produce ../index.html, the file nginx actually
// serves. Plain Node, no dependencies, so it needs nothing beyond what
// `npm ci` already installs for the Vite build itself.
//
// To change the overlay app, edit ../overlay.html directly and rerun the
// build (or just `npm run build` - it doesn't touch overlay.html, only
// reads it). To change the React app, edit files under src/ as usual.
//
// ESM (package.json has "type": "module", same as the rest of this file's
// project) - uses import, not require().

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_DIR = path.join(__dirname, '..');
const FRONTEND_DIR = path.join(APP_DIR, '..');
const DIST_DIR = path.join(APP_DIR, 'dist');
const OVERLAY_PATH = path.join(FRONTEND_DIR, 'overlay.html');
const OUTPUT_PATH = path.join(FRONTEND_DIR, 'index.html');

function fail(msg) {
  console.error(`[assemble] ${msg}`);
  process.exit(1);
}

// --- 1. Read Vite's build output and pull out the asset tags -----------

const distIndexPath = path.join(DIST_DIR, 'index.html');
if (!fs.existsSync(distIndexPath)) {
  fail(`${distIndexPath} not found - did \`vite build\` run first?`);
}
const distHtml = fs.readFileSync(distIndexPath, 'utf-8');

const scriptMatches = [...distHtml.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g)];
const cssMatches = [...distHtml.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)];
const preloadMatches = [...distHtml.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"[^>]*>/g)];

if (!scriptMatches.length) fail('no built <script type="module" src="..."> found in dist/index.html');

const scriptTags = scriptMatches.map((m) => `  <script type="module" src="${m[1]}"></script>`).join('\n');
const preloadTags = preloadMatches.map((m) => `  <link rel="modulepreload" href="${m[1]}">`).join('\n');
const cssTags = cssMatches.map((m) => `  <link rel="stylesheet" href="${m[1]}">`).join('\n');

// --- 2. Fixed, stable fragments preserved from the original index.html --
// These three pieces never change build-to-build (no hashed filenames,
// no Tailwind output) so they're kept here rather than as separate files.

const HEAD_PRELUDE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OctaveGrowthIntelligence</title>
  <link rel="icon" type="image/png" href="/octave-icon.png">`;

// Sets window.__ORGCOMMS_COMPANY__/__ORGCOMMS_SESSION__ from localStorage
// and applies the saved theme (data-theme attribute) before either app
// renders, so there's no flash of the wrong theme or a moment where the
// React app doesn't know who's signed in yet.
const PREMOUNT_THEME_SCRIPT = `  <script>(function(){
    try {
      var raw = localStorage.getItem('orgcomms_session');
      if (raw) {
        var s = JSON.parse(raw);
        if (s && s.company) window.__ORGCOMMS_COMPANY__ = s.company;
        window.__ORGCOMMS_SESSION__ = s;
      }
    } catch (e) {}
    try {
      var theme = localStorage.getItem('octave_theme') || 'dark';
      document.documentElement.setAttribute('data-theme', theme);
    } catch (e) {}
  })();</script>`;

// Makes every external link open in a new tab - applies to links rendered
// by either app (React or the overlay), since it just walks the DOM.
const EXTERNAL_LINK_SCRIPT = `  <script>(function(){function m(a){var h=a.getAttribute("href");if(!h)return;try{var u=new URL(h,document.baseURI);if((u.protocol==="http:"||u.protocol==="https:")&&u.host!==location.host){a.target="_blank";a.rel="noopener noreferrer";}}catch(e){}}function s(){document.querySelectorAll("a[href]").forEach(m);}if(document.readyState!=="loading"){s();}else{document.addEventListener("DOMContentLoaded",s);}document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(a){m(a);}},true);})();</script>`;

// --- 3. Overlay app - read verbatim, never modified by this script ------

if (!fs.existsSync(OVERLAY_PATH)) fail(`${OVERLAY_PATH} not found`);
const overlay = fs.readFileSync(OVERLAY_PATH, 'utf-8');

// --- 4. Assemble ---------------------------------------------------------

const output = `${HEAD_PRELUDE}
${cssTags}
${preloadTags}
</head>
<body>
  <div id="root"></div>
${PREMOUNT_THEME_SCRIPT}
${scriptTags}
${EXTERNAL_LINK_SCRIPT}

${overlay}`;

fs.writeFileSync(OUTPUT_PATH, output);
console.log(`[assemble] wrote ${OUTPUT_PATH} (${(output.length / 1024).toFixed(1)} KB)`);
