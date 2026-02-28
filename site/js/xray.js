/**
 * xray.js — Public site transparency mode.
 *
 * When enabled (Ctrl/Cmd+Shift+X or clicking the ⊡ button),
 * overlays every content element with its EO operator annotation:
 *   op(target, operand)
 *
 * Also shows a side panel with the raw event stream for the current page,
 * loaded from the JSON state file.
 *
 * This is opt-in and adds zero overhead when disabled.
 */
(function () {
  let enabled = false;
  let panel = null;

  const OP_COLORS = {
    INS: '#4ade80', DES: '#60a5fa', ALT: '#fbbf24',
    SEG: '#c084fc', CON: '#34d399', SYN: '#818cf8',
    SUP: '#f472b6', REC: '#fb923c', NUL: '#9ca3af',
  };
  const OP_SYMBOLS = {
    INS: '△', DES: '⊡', ALT: '∿', SEG: '｜',
    CON: '⋈', SYN: '∨', SUP: '⊕', REC: '⟳', NUL: '∅',
  };

  // ── Relative timestamp ──────────────────────────────────────────────────────
  function timeAgo(ts) {
    if (!ts) return '';
    var seconds = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    if (days < 7) return days + 'd ago';
    var weeks = Math.floor(days / 7);
    if (weeks < 5) return weeks + 'w ago';
    var months = Math.floor(days / 30);
    if (months < 12) return months + 'mo ago';
    return Math.floor(days / 365) + 'y ago';
  }

  // ── Create toggle button ────────────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.id = 'xray-toggle';
  btn.title = 'Toggle X-Ray transparency mode (Ctrl+Shift+X)';
  btn.textContent = '⊡';
  Object.assign(btn.style, {
    position: 'fixed',
    bottom: '1rem',
    left: '1rem',
    background: '#1a1a1a',
    border: '1px solid #444',
    borderRadius: '6px',
    color: '#888',
    padding: '6px 12px',
    cursor: 'pointer',
    fontFamily: 'monospace',
    fontSize: '14px',
    zIndex: '9998',
    transition: '.15s',
  });
  btn.onclick = toggle;
  document.body.appendChild(btn);

  // ── Keyboard shortcut ───────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'X') {
      e.preventDefault();
      toggle();
    }
  });

  // ── Toggle ──────────────────────────────────────────────────────────────────
  function toggle() {
    enabled = !enabled;
    btn.style.background = enabled ? '#7c6fcd22' : '#1a1a1a';
    btn.style.borderColor = enabled ? '#7c6fcd' : '#444';
    btn.style.color = enabled ? '#9b8fd4' : '#888';
    document.body.classList.toggle('xray-enabled', enabled);

    if (enabled) {
      annotateBlocks();
      showPanel();
    } else {
      clearAnnotations();
      if (panel) { panel.remove(); panel = null; }
    }
  }

  // ── Annotate DOM blocks with EO operator info ───────────────────────────────
  function annotateBlocks() {
    // Blocks have data-eo-* attributes set by the renderer
    document.querySelectorAll('[data-eo-op]').forEach((el) => {
      if (el.querySelector('.xray-annotation')) return; // already annotated
      const op = el.getAttribute('data-eo-op') ?? '?';
      const target = el.getAttribute('data-eo-target') ?? '';
      const color = OP_COLORS[op] ?? '#888';
      const sym = OP_SYMBOLS[op] ?? '?';

      const ann = document.createElement('div');
      ann.className = 'xray-annotation';
      Object.assign(ann.style, {
        position: 'absolute',
        top: '2px',
        right: '2px',
        background: '#0f0f0fdd',
        border: `1px solid ${color}`,
        borderRadius: '4px',
        padding: '1px 6px',
        fontSize: '11px',
        fontFamily: 'monospace',
        color,
        zIndex: '100',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      });
      ann.textContent = `${sym} ${op}(${target})`;

      // Make the parent position:relative so the annotation sits on it
      const parent = el;
      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
        parent.dataset.xrayPositionFixed = 'true';
      }
      parent.appendChild(ann);
    });

    // Also highlight all annotated blocks with a subtle border
    document.querySelectorAll('[data-eo-op]').forEach((el) => {
      el.classList.add('xray-highlighted');
    });
  }

  function clearAnnotations() {
    document.querySelectorAll('.xray-annotation').forEach((el) => el.remove());
    document.querySelectorAll('[data-xray-position-fixed]').forEach((el) => {
      (el).style.position = '';
    });
    document.querySelectorAll('.xray-highlighted').forEach((el) => {
      el.classList.remove('xray-highlighted');
    });
  }

  // ── Side panel: event stream ────────────────────────────────────────────────
  async function showPanel() {
    if (panel) return;

    panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed',
      top: '60px',
      right: '0',
      width: '360px',
      maxHeight: 'calc(100vh - 80px)',
      background: '#0a0a0a',
      border: '1px solid #333',
      borderRadius: '8px 0 0 8px',
      zIndex: '9997',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'monospace',
      fontSize: '12px',
      overflow: 'hidden',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '8px 12px',
      borderBottom: '1px solid #333',
      background: '#111',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
    });
    header.innerHTML = '<span style="color:#7c6fcd;font-weight:700">⊡ X-Ray — Event Stream</span>';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, { marginLeft: 'auto', background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '14px' });
    closeBtn.onclick = toggle;
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const body = document.createElement('div');
    Object.assign(body.style, { flex: '1', overflow: 'auto', padding: '4px 0' });
    body.innerHTML = '<div style="color:#555;padding:12px;text-align:center">Loading events…</div>';
    panel.appendChild(body);

    document.body.appendChild(panel);

    // Load the content's state JSON
    try {
      // Determine current content ID from page URL
      const pathParts = window.location.pathname.replace(/\/$/, '').split('/');
      const slug = pathParts.at(-1) ?? '';
      const type = pathParts.at(-2) ?? '';

      const contentId = type === 'exp' ? `experiment:${slug}` : `${type}:${slug}`;
      const fileName = contentId.replace(':', '-') + '.json';
      const baseEl = document.querySelector('base');
      const base = baseEl ? baseEl.getAttribute('href').replace(/\/$/, '') : '';

      const resp = await fetch(`${base}/generated/state/content/${fileName}`);
      if (!resp.ok) throw new Error('No state file');
      const data = await resp.json();
      const history = data.history ?? [];

      body.innerHTML = '';
      if (!history.length) {
        body.innerHTML = '<div style="color:#555;padding:12px;text-align:center">No event history in snapshot.</div>';
        return;
      }

      for (const entry of [...history].reverse()) {
        const color = OP_COLORS[entry.op] ?? '#888';
        const sym = OP_SYMBOLS[entry.op] ?? '?';
        const target = entry.target ?? data.content_id ?? '';
        const summary = entry.summary ? `, {${entry.summary}}` : '';
        const row = document.createElement('div');
        Object.assign(row.style, {
          padding: '5px 12px',
          borderBottom: '1px solid #1a1a1a',
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
        });
        row.innerHTML = `
          <div style="display:flex;align-items:center;gap:6px">
            <span style="color:${color};font-weight:700;font-size:14px">${sym}</span>
            <span style="color:${color};font-weight:600">${entry.op}</span><span style="color:#aaa">(</span><span style="color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${target}${summary}</span><span style="color:#aaa">)</span>
            <span style="color:#555;font-size:10px;margin-left:auto;flex-shrink:0">${timeAgo(entry.ts)}</span>
          </div>
        `;
        body.appendChild(row);
      }

      // Show module topology at the top
      const topo = document.createElement('div');
      Object.assign(topo.style, { padding: '8px 12px', background: '#111', borderBottom: '1px solid #1a1a1a', color: '#888', fontSize: '11px' });
      topo.innerHTML = `
        <strong style="color:#7c6fcd">${data.content_id ?? ''}</strong>
        &nbsp;·&nbsp; ${data.content_type ?? ''} &nbsp;·&nbsp; ${history.length} events
        &nbsp;·&nbsp; built <span style="color:#aaa">${data.meta?.updated_at ? timeAgo(data.meta.updated_at) : 'unknown'}</span>
      `;
      body.insertBefore(topo, body.firstChild);
    } catch {
      body.innerHTML = '<div style="color:#555;padding:12px;text-align:center">No event data (home page or not yet built).</div>';
    }
  }

  // ── CSS for highlighted blocks ──────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    body.xray-enabled .xray-highlighted {
      outline: 1px dashed #7c6fcd66 !important;
      outline-offset: 2px;
    }
    body.xray-enabled .block-eo-wrap,
    body.xray-enabled .block-text,
    body.xray-enabled .block-callout,
    body.xray-enabled .block-quote,
    body.xray-enabled .block-image,
    body.xray-enabled .wiki-body > *,
    body.xray-enabled .blog-body > *,
    body.xray-enabled .exp-entry {
      outline: 1px dashed #7c6fcd44;
      outline-offset: 2px;
      position: relative;
    }
  `;
  document.head.appendChild(style);
})();
