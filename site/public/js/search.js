/* Site search — loads search_index.json and runs client-side Fuse.js */
(async function () {
  const input = document.getElementById('search-input');
  const resultsBox = document.getElementById('search-results');
  if (!input || !resultsBox) return;

  const base = document.querySelector('link[rel="alternate"]')?.getAttribute('href')?.replace('/generated/state/index.json', '') ?? '';

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
    const resp = await fetch(`${base}/search_index.json`);
    const data = await resp.json();
    fuse = new window.Fuse(data, {
      keys: ['title', 'excerpt', 'tags'],
      threshold: 0.35,
      includeScore: true,
    });
  }

  let debounceTimer;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) { resultsBox.hidden = true; resultsBox.innerHTML = ''; return; }
      await ensureFuse();
      const hits = fuse.search(q).slice(0, 8);
      if (!hits.length) { resultsBox.hidden = true; return; }
      resultsBox.innerHTML = hits
        .map((h) => `<a class="search-result-item" href="${h.item.url}">${h.item.title}<span class="tag" style="margin-left:.5rem">${h.item.type}</span></a>`)
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
