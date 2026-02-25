import { defineConfig } from 'astro/config';

// Site base path for GitHub Pages sub-path deployment.
// Override with SITE_BASE env var if needed (e.g. SITE_BASE=/repo-name).
const base = process.env.SITE_BASE ?? '/';

export default defineConfig({
  output: 'static',
  base,
  build: {
    // Output into site/dist, which GitHub Actions picks up and deploys.
    outDir: './dist',
    format: 'directory',
  },
  server: {
    port: 4321,
  },
});
