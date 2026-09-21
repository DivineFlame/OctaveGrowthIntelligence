import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds to dist/ as a plain asset bundle (hashed JS + CSS files, no
// inlining) - scripts/assemble.js then splices the built <script>/<link>
// tags into the preserved overlay app (see overlay.html) to produce the
// final frontend/index.html. Kept as external files rather than inlined
// on purpose: it lets the nginx CSP (script-src 'self') cover this bundle
// without needing a recomputed sha256 hash every build, the way the old
// single-file inline bundle required.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
  },
});
