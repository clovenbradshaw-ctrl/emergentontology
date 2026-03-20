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

  async function fetchAllXanoPages(xanoBase) {
    let all = [];
    let page = 1;
    while (true) {
      const resp = await fetch(xanoBase + '/get_public_eowiki?page=' + page + '&per_page=25', { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) break;
      const data = await resp.json();
      const records = Array.isArray(data) ? data : (data.items || []);
      all = all.concat(records);
      if (!data.nextPage || data.curPage >= data.pageTotal) break;
      page = data.nextPage;
    }
    return all;
  }

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

    // If static index is empty, build from Xano public API (paginated)
    if (!data || data.length === 0) {
      try {
        const allRecords = await fetchAllXanoPages(XANO_BASE);
        if (allRecords.length > 0) {
          // Try site:index record first
          const indexRec = allRecords.find(r => r.record_id === 'site:index');
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
              keywords: e.keywords || [],
              description: e.description || '',
              excerpt: e.description || '',
            }));
          } else {
            // No site:index — build search data from individual content records
            data = allRecords
              .filter(r => r.record_id && r.record_id !== 'site:index' && r.values)
              .map(r => {
                try {
                  const parsed = JSON.parse(r.values);
                  const meta = parsed.meta || {};
                  if (meta.status === 'archived') return null;
                  return {
                    title: meta.title || r.displayName || '',
                    type: typeLabels[meta.content_type] || meta.content_type || '',
                    url: typeUrl(meta.content_type, meta.slug),
                    tags: meta.tags || [],
                    keywords: meta.keywords || [],
                    description: meta.description || '',
                    excerpt: meta.description || '',
                  };
                } catch (e) { return null; }
              })
              .filter(Boolean);
          }
        }
      } catch (e) { /* ignore */ }
    }

    fuse = new window.Fuse(data, {
      keys: [
        { name: 'title', weight: 2 },
        { name: 'keywords', weight: 1.5 },
        { name: 'tags', weight: 1.2 },
        { name: 'description', weight: 1 },
        { name: 'excerpt', weight: 0.8 },
      ],
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
      var isAdmin = false;
      try { isAdmin = localStorage.getItem('eo_xano_auth') === '1'; } catch (e) {}
      resultsBox.innerHTML = hits
        .map((h) => {
          var qParam = encodeURIComponent(q);
          let html = `<a class="search-result-item" href="${escHtml(h.item.url)}?q=${qParam}"><span class="search-result-type">${escHtml(h.item.type)}</span> ${escHtml(h.item.title)}`;
          if (h.item.description) html += `<span class="search-result-desc">${escHtml(h.item.description)}</span>`;
          if (isAdmin) {
            var editUrl = h.item.url.replace(/\/$/, '').replace(base, '');
            var editParts = editUrl.split('/').filter(Boolean);
            var editType = editParts[0] || 'wiki';
            var editSlug = editParts[1] || '';
            if (editType === 'exp') editType = 'experiment';
            html += `<span class="search-result-edit" data-edit-href="${base}/admin/#${editType}/${escHtml(editSlug)}" title="Open in editor">&#9998;</span>`;
          }
          html += `</a>`;
          return html;
        })
        .join('');
      resultsBox.hidden = false;
    }, 150);
  });

  resultsBox.addEventListener('click', (e) => {
    var editBtn = e.target.closest('.search-result-edit');
    if (editBtn) {
      e.preventDefault();
      e.stopPropagation();
      var href = editBtn.getAttribute('data-edit-href');
      if (href) {
        var drawer = document.getElementById('admin-drawer');
        var drawerOverlay = document.getElementById('admin-drawer-overlay');
        var iframe = document.getElementById('admin-drawer-iframe');
        if (drawer && drawerOverlay && iframe) {
          iframe.src = href;
          drawer.classList.add('open');
          drawerOverlay.classList.add('open');
          document.body.style.overflow = 'hidden';
        } else {
          window.open(href, '_blank');
        }
      }
      resultsBox.hidden = true;
    }
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
