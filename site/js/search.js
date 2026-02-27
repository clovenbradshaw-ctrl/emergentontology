/* Site search — loads search_index.json and runs client-side Fuse.js */
/* Falls back to building a search index from the public Xano API when static index is empty */
(async function () {
  const input = document.getElementById('search-input');
  const resultsBox = document.getElementById('search-results');
  if (!input || !resultsBox) return;

  const baseEl = document.querySelector('base');
  const base = baseEl ? baseEl.getAttribute('href').replace(/\/$/, '') : '';
  const XANO_BASE = 'https://xvkq-pq7i-idtl.n7d.xano.io/api:GGzWIVAW';

  var typeLabels = { wiki: 'Wiki', blog: 'Blog', experiment: 'Experiment', page: 'Page' };

  function typeUrl(type, slug) {
    switch (type) {
      case 'wiki': return base + '/wiki/' + slug + '/';
      case 'blog': return base + '/blog/' + slug + '/';
      case 'experiment': return base + '/exp/' + slug + '/';
      case 'page': return base + '/page/' + slug + '/';
      default: return base + '/';
    }
  }

  // Load Fuse.js from CDN (deferred, only on first keystroke)
  let fuse = null;

  async function ensureFuse() {
    if (fuse) return;
    if (!window.Fuse) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/fuse.js@7/dist/fuse.min.js';
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    // Try static search index first
    let data = [];
    try {
      const resp = await fetch(`${base}/generated/search_index.json`);
      if (resp.ok) data = await resp.json();
    } catch (e) { /* ignore */ }

    // If static index is empty, build from Xano public API
    if (!data || data.length === 0) {
      try {
        const resp = await fetch(XANO_BASE + '/get_public_eowiki', { signal: AbortSignal.timeout(10000) });
        if (resp.ok) {
          const records = await resp.json();
          if (Array.isArray(records) && records.length > 0) {
            const isCurrentFormat = records[0].record_id !== undefined && records[0].values !== undefined;
            if (isCurrentFormat) {
              const indexRec = records.find(r => r.record_id === 'site:index');
              if (indexRec) {
                const siteIndex = JSON.parse(indexRec.values);
                const entries = (siteIndex.nav && siteIndex.nav.length > 0)
                  ? siteIndex.nav
                  : (siteIndex.entries || []).filter(e => e.status === 'published' && e.visibility === 'public');
                data = entries.map(e => ({
                  title: e.title,
                  type: typeLabels[e.content_type] || e.content_type,
                  url: typeUrl(e.content_type, e.slug),
                  tags: e.tags || [],
                  excerpt: '',
                }));
              }
            }
          }
        }
      } catch (e) { /* ignore */ }
    }

    fuse = new window.Fuse(data, {
      keys: ['title', 'excerpt', 'tags'],
      threshold: 0.35,
      includeScore: true,
    });
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  let debounceTimer;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) { resultsBox.hidden = true; resultsBox.innerHTML = ''; return; }
      await ensureFuse();
      const hits = fuse.search(q).slice(0, 8);
      if (!hits.length) {
        resultsBox.innerHTML = '<div class="search-no-results">No results found</div>';
        resultsBox.hidden = false;
        return;
      }
      resultsBox.innerHTML = hits
        .map((h) => `<a class="search-result-item" href="${escHtml(h.item.url)}"><span class="search-result-type">${escHtml(h.item.type)}</span> ${escHtml(h.item.title)}</a>`)
        .join('');
      resultsBox.hidden = false;
    }, 150);
  });

  document.addEventListener('click', (e) => {
    if (!resultsBox.contains(e.target) && e.target !== input) {
      resultsBox.hidden = true;
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { resultsBox.hidden = true; input.value = ''; }
  });
})();
