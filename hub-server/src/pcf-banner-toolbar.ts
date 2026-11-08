const ADAPTER_ID = 'pahub-banner-toolbar';

// Hosted presentation only. Move the original nodes (never clone/rebind them)
// so v2.6 menu state, click handlers, keyboard shortcuts and exports stay intact.
// Layout: brand | centered document capsule | personal capsule (nickname, guide, theme).
const TOOLBAR = `<script id="pahub-banner-toolbar">
(() => {
  'use strict';
  const CHEVRON = '<svg class="menu-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg>';
  function relabel(button, label) {
    if (!button) return;
    const span = button.querySelector('span');
    if (span) { span.textContent = label; return; }
    for (const text of button.childNodes) if (text.nodeType === 3 && text.textContent.trim()) { text.textContent = label; return; }
    button.append(label);
  }
  function buildExchangeMenu(exportBtn, importBtn) {
    const group = document.createElement('div');
    group.id = 'pahub-io'; group.className = 'pahub-io';
    const trigger = document.createElement('button');
    trigger.id = 'pahub-io-menu-btn'; trigger.type = 'button'; trigger.className = 'io-trigger';
    trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', 'pahub-io-panel'); trigger.setAttribute('aria-label', 'More Builder exchange options');
    trigger.title = 'More Builder exchange options'; trigger.innerHTML = CHEVRON;
    const panel = document.createElement('div');
    panel.id = 'pahub-io-panel'; panel.className = 'io-panel'; panel.setAttribute('role', 'menu'); panel.hidden = true;
    const exportItem = document.createElement('button');
    exportItem.type = 'button'; exportItem.id = 'pahub-io-export';
    exportItem.innerHTML = (exportBtn.querySelector('svg')?.outerHTML || '') + '<span>Export to Builder</span>';
    exportItem.setAttribute('role', 'menuitem');
    exportItem.addEventListener('click', () => { close(); exportBtn.click(); });
    importBtn.setAttribute('role', 'menuitem');
    panel.append(exportItem, importBtn);
    group.append(exportBtn, trigger, panel);
    function items() { return [...panel.querySelectorAll('button')].filter(b => !b.disabled); }
    function open(focusFirst) {
      if (typeof window.closeBannerMenus === 'function') window.closeBannerMenus();
      panel.hidden = false; group.classList.add('io-open'); trigger.setAttribute('aria-expanded', 'true');
      if (focusFirst) items()[0]?.focus();
    }
    function close(refocus) {
      if (panel.hidden) return;
      panel.hidden = true; group.classList.remove('io-open'); trigger.setAttribute('aria-expanded', 'false');
      if (refocus) trigger.focus();
    }
    trigger.addEventListener('click', e => { e.stopPropagation(); panel.hidden ? open(false) : close(); });
    trigger.addEventListener('keydown', e => { if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(true); } });
    panel.addEventListener('click', e => { if (e.target.closest('button')) close(); });
    panel.addEventListener('keydown', e => {
      const list = items(), i = list.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    });
    // Keep the menu inside the viewport when the capsule sits near an edge.
    const placePanel = () => {
      panel.style.left = '0px'; panel.style.right = 'auto';
      const rect = panel.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) panel.style.left = Math.max(8 - rect.left, window.innerWidth - rect.right - 8) + 'px';
      if (rect.left < 8) panel.style.left = (8 - rect.left) + 'px';
    };
    new MutationObserver(() => { if (!panel.hidden) placePanel(); }).observe(panel, { attributes:true, attributeFilter:['hidden'] });
    window.addEventListener('resize', () => { if (!panel.hidden) placePanel(); });
    window.addEventListener('scroll', () => { if (!panel.hidden) placePanel(); }, { passive:true });
    document.addEventListener('click', e => { if (!group.contains(e.target)) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    return group;
  }
  function mount() {
    if (!window.PAHUB) return true;
    const header = document.querySelector('header.banner');
    if (!header || header.classList.contains('pahub-unified')) return true;
    const hosted = document.getElementById('pahub-hosted-actions');
    const nav = header.querySelector('.banner-nav');
    const theme = document.getElementById('theme-btn');
    const name = document.getElementById('pahub-name');
    const help = document.getElementById('help-btn');
    const exportBtn = document.getElementById('pahub-export');
    const importBtn = document.getElementById('pahub-import');
    const exchange = document.getElementById('pahub-exchange');
    const fileOptions = document.getElementById('more-btn');
    const actions = header.querySelector('.banner-actions');
    if (!hosted || !nav || !theme || !name || !help || !exportBtn || !importBtn || !exchange || !fileOptions || !actions) return false;

    relabel(exportBtn, 'Export'); exportBtn.setAttribute('aria-label', 'Export to Builder'); exportBtn.title = 'Export to Builder';
    relabel(exchange, 'History'); exchange.setAttribute('aria-label', 'Shipyard correspondence history'); exchange.title = 'Shipyard correspondence history';
    relabel(fileOptions, 'File Options');
    relabel(importBtn, 'Import Builder Reply');
    if (name.textContent.trim() === 'Set nickname') name.textContent = 'Set Nickname';

    const toolbar = document.createElement('div');
    toolbar.className = 'pahub-toolbar'; toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', 'Hosted PCF tools');
    hosted.classList.add('toolbar-group', 'capsule'); hosted.setAttribute('aria-label', 'Document tools');
    nav.classList.add('toolbar-group', 'capsule'); nav.setAttribute('aria-label', 'Document tools');
    const exchangeMenu = buildExchangeMenu(exportBtn, importBtn);
    nav.append(exchangeMenu, exchange, fileOptions);
    hosted.remove();
    toolbar.append(nav);
    header.querySelector('.brand').after(toolbar);

    const personal = document.createElement('div');
    personal.className = 'toolbar-group capsule personal'; personal.setAttribute('aria-label', 'Identity, guide and appearance');
    personal.append(name, help, theme);
    actions.prepend(personal);

    for (const button of header.querySelectorAll('.capsule button')) {
      const title = button.getAttribute('aria-label') || button.textContent.trim();
      if (!button.title) button.title = title;
      if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', title);
    }
    header.classList.add('pahub-unified');
    const style = document.createElement('style'); style.id = 'pahub-banner-toolbar-style';
    style.textContent = CSS; document.head.append(style);

    // Offline snapshots never carry hosted-only controls.
    if (typeof window.snapshotHTML === 'function' && !window.snapshotHTML.pahubWrapped) {
      const original = window.snapshotHTML;
      const wrapped = function (...args) {
        const html = original.apply(this, args);
        try {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          doc.querySelectorAll('#pahub-io,#pahub-hosted-actions').forEach(el => el.remove());
          return '<!doctype html>\\n' + doc.documentElement.outerHTML;
        } catch { return html; }
      };
      wrapped.pahubWrapped = true; window.snapshotHTML = wrapped;
    }
    return true;
  }
  const CSS = \`
  @media screen {
    header.banner.pahub-unified { display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr); align-items:center; gap:16px; height:auto!important; min-height:79px; padding:14px 24px; overflow:visible; }
    header.banner.pahub-unified .brand { grid-column:1; grid-row:1; min-width:0; }
    header.banner.pahub-unified .brand .logo { width:32px; height:32px; }
    header.banner.pahub-unified .pahub-toolbar { grid-column:2; grid-row:1; display:flex; align-items:center; justify-content:center; gap:0; width:max-content; max-width:100%; min-width:0; }
    header.banner.pahub-unified .banner-actions { grid-column:3; grid-row:1; justify-self:end; display:flex; flex-direction:row; flex-wrap:nowrap; align-items:center; gap:12px; min-width:0; }
    header.banner.pahub-unified .banner-actions > .personal { order:2; }
    header.banner.pahub-unified .connection-status { order:1; display:flex; flex-direction:column; align-items:flex-end; justify-content:center; gap:3px; width:auto; max-width:240px; min-width:0; font-size:11px; line-height:1.25; text-align:right; }
    header.banner.pahub-unified .connection-status > * { margin:0!important; max-width:100%; }
    header.banner.pahub-unified .connection-status .save-line { width:auto; color:#d7efe9cc; }

    /* PAPC capsule: a dark translucent pill holding rounded-full buttons. */
    header.banner.pahub-unified .capsule { display:flex; flex:0 0 auto; align-items:center; gap:2px; width:max-content; max-width:none; margin:0; padding:4px; border:1px solid rgba(255,255,255,.10)!important; border-radius:999px!important; background:rgba(0,0,0,.15)!important; box-shadow:inset 0 2px 4px rgba(0,0,0,.10)!important; backdrop-filter:blur(4px); }
    header.banner.pahub-unified :is(.capsule,.capsule > .banner-menu,.capsule > .pahub-io) > button { display:inline-flex!important; align-items:center; justify-content:center; gap:6px!important; height:30px!important; min-height:30px!important; min-width:0!important; padding:0 11px!important; margin:0!important; border:0!important; border-radius:999px!important; background:transparent!important; color:rgba(240,253,250,.78)!important; font:900 10px/1 var(--font)!important; letter-spacing:.07em!important; text-transform:uppercase!important; white-space:nowrap; box-shadow:none!important; transition:background-color .2s,color .2s,box-shadow .2s; cursor:pointer; }
    header.banner.pahub-unified :is(.capsule,.capsule > .banner-menu,.capsule > .pahub-io) > button:hover:not(:disabled) { background:rgba(255,255,255,.12)!important; color:#fff!important; }
    header.banner.pahub-unified .capsule button:disabled { opacity:.45; cursor:not-allowed; }
    header.banner.pahub-unified :is(.capsule,.capsule > .banner-menu,.capsule > .pahub-io) > button:focus-visible { outline:2px solid #fff; outline-offset:1px; }
    header.banner.pahub-unified .capsule .banner-menu.menu-open > button,
    header.banner.pahub-unified .capsule .pahub-io.io-open > button { background:rgba(255,255,255,.12)!important; color:#fff!important; }

    /* Only Save is filled: the PAPC active-pill look (white, teal ink). */
    header.banner.pahub-unified .capsule :is(#save-btn,#save-menu-btn),
    header.banner.pahub-unified .capsule :is(#save-btn,#save-menu-btn):hover:not(:disabled) { background:#fff!important; color:#0f766e!important; box-shadow:0 8px 16px -8px rgba(0,0,0,.35)!important; }
    header.banner.pahub-unified .capsule :is(#save-btn,#save-menu-btn):hover:not(:disabled) { background:#f0fdfa!important; }
    header.banner.pahub-unified .banner-save-group { display:flex; gap:0; margin-right:2px; }
    header.banner.pahub-unified .capsule #save-btn { padding:0 12px 0 15px!important; border-radius:999px 0 0 999px!important; }
    header.banner.pahub-unified .capsule #save-menu-btn { width:28px; padding:0 8px 0 6px!important; border-radius:0 999px 999px 0!important; border-left:1px solid rgba(15,118,110,.18)!important; }

    /* Merged Builder exchange split button: Export is the default action. */
    header.banner.pahub-unified .pahub-io { position:relative; display:flex; flex:0 0 auto; }
    header.banner.pahub-unified .capsule #pahub-export { padding:0 6px 0 12px!important; border-radius:999px 0 0 999px!important; }
    header.banner.pahub-unified .capsule #pahub-io-menu-btn { width:26px; padding:0 8px 0 3px!important; border-radius:0 999px 999px 0!important; }
    header.banner.pahub-unified .capsule #pahub-exchange { padding:0 11px!important; }
    header.banner.pahub-unified .pahub-io .io-panel { position:absolute; top:calc(100% + 9px); left:0; z-index:150; width:max-content; min-width:200px; max-width:calc(100vw - 16px); padding:6px; border:1px solid var(--line); border-radius:12px; background:var(--surface); color:var(--ink); box-shadow:0 18px 40px -18px rgba(0,0,0,.45); display:flex; flex-direction:column; gap:2px; }
    header.banner.pahub-unified .pahub-io .io-panel[hidden] { display:none; }

    header.banner.pahub-unified .capsule svg { width:13px!important; height:13px!important; flex:0 0 13px!important; }
    header.banner.pahub-unified .capsule svg.menu-chevron { width:10px!important; height:10px!important; flex:0 0 10px!important; }
    header.banner.pahub-unified .capsule button::before { width:13px; height:13px; flex:0 0 13px; }
    header.banner.pahub-unified #save-menu-btn::before, header.banner.pahub-unified :is(#pahub-io-menu-btn,#pahub-export,#pahub-exchange,#pahub-io-export,#pahub-import,#pahub-name)::before { display:none!important; content:none!important; }
    header.banner.pahub-unified .banner-menu { position:relative; display:flex; flex:0 0 auto; }
    header.banner.pahub-unified .banner-menu .banner-menu-panel { top:calc(100% + 9px); left:0; right:auto; transform:none; background:var(--surface); border-color:var(--line); color:var(--ink); border-radius:12px; z-index:150; }
    /* Menu items sit on a document surface, not on the teal toolbar pill. */
    header.banner.pahub-unified .capsule :is(.banner-menu-panel,.io-panel) button { display:flex!important; align-items:center; justify-content:flex-start!important; gap:6px; width:100%; min-width:0; height:34px!important; padding:0 12px!important; margin:0; border:0!important; border-radius:8px!important; background:transparent!important; color:var(--ink)!important; font:600 12px/1.3 var(--font); letter-spacing:.02em!important; text-transform:none!important; text-align:left; white-space:nowrap; box-shadow:none!important; }
    header.banner.pahub-unified .capsule :is(.banner-menu-panel,.io-panel) button:is(:hover,:focus-visible):not(:disabled) { background:var(--green-soft)!important; color:var(--ink)!important; }
    header.banner.pahub-unified .capsule :is(.banner-menu-panel,.io-panel) button:focus-visible { outline:2px solid var(--green); outline-offset:-2px; }
  }
  @media screen and (max-width:1680px) {
    header.banner.pahub-unified { position:relative; }
    header.banner.pahub-unified .connection-status { position:absolute; top:calc(100% + 5px); right:24px; flex-direction:row; align-items:center; gap:10px; max-width:none; white-space:nowrap; z-index:5; }
    header.banner.pahub-unified .connection-status, header.banner.pahub-unified .connection-status * { color:var(--muted)!important; font-size:10.5px!important; }
  }
  @media screen and (max-width:1400px) {
    header.banner.pahub-unified { grid-template-columns:minmax(0,1fr) auto; row-gap:10px; }
    header.banner.pahub-unified .banner-actions { grid-column:2; grid-row:1; }
    header.banner.pahub-unified .pahub-toolbar { grid-column:1/-1; grid-row:2; justify-self:center; }
  }
  @media screen and (max-width:900px) {
    header.banner.pahub-unified .pahub-toolbar { flex-wrap:wrap; width:auto; max-width:100%; }
    header.banner.pahub-unified .capsule { flex-wrap:wrap; justify-content:center; max-width:100%; min-width:0; border-radius:20px!important; }
  }
  @media screen and (max-width:600px) {
    header.banner.pahub-unified { grid-template-columns:1fr; padding:12px; }
    header.banner.pahub-unified .banner-actions { grid-column:1; grid-row:2; justify-self:center; align-items:center; }
    header.banner.pahub-unified .pahub-toolbar { grid-row:3; max-width:calc(100vw - 24px); }
    header.banner.pahub-unified .capsule { border-radius:16px!important; }
  }
  @media print { .pahub-toolbar, header.banner.pahub-unified .personal { display:none!important; } }
  \`;
  function start() {
    if (mount()) return;
    const observer = new MutationObserver(() => { if (mount()) { observer.disconnect(); clearTimeout(expiry); } });
    observer.observe(document.body, { childList:true, subtree:true });
    const expiry = setTimeout(() => observer.disconnect(), 10000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true }); else start();
})();
</script>`;

export function bannerToolbarHTML(html: string): string {
  if (html.includes('id="' + ADAPTER_ID + '"')) return html;
  const closing = [...html.matchAll(/<\/body\s*>/gi)].at(-1);
  if (closing?.index === undefined) return html;
  return html.slice(0, closing.index) + TOOLBAR + '\n' + html.slice(closing.index);
}
