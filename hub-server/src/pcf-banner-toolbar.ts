const ADAPTER_ID = 'pahub-banner-toolbar';

// Hosted presentation only. Move the original nodes (never clone/rebind them)
// so v2.6 menu state, click handlers, keyboard shortcuts and exports stay intact.
const TOOLBAR = `<script id="pahub-banner-toolbar">
(() => {
  'use strict';
  function mount() {
    if (!window.PAHUB) return true;
    const header = document.querySelector('header.banner');
    if (!header || header.classList.contains('pahub-unified')) return true;
    const hosted = document.getElementById('pahub-hosted-actions');
    const nav = header.querySelector('.banner-nav');
    const theme = document.getElementById('theme-btn');
    const name = document.getElementById('pahub-name');
    if (!hosted || !nav || !theme || !name) return false;
    const toolbar = document.createElement('div');
    toolbar.className = 'pahub-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Hosted PCF tools');
    const personal = document.createElement('div');
    personal.className = 'toolbar-group';
    personal.setAttribute('aria-label', 'Appearance and identity');
    personal.append(theme, name);
    hosted.classList.add('toolbar-group'); nav.classList.add('toolbar-group');
    toolbar.append(hosted, nav, personal);
    header.querySelector('.brand').after(toolbar);
    const labels = { 'pahub-exchange': 'Shipyard Correspondence', 'more-btn': 'File Options' };
    for (const [id, label] of Object.entries(labels)) {
      const button = document.getElementById(id), span = button.querySelector('span');
      if (span) span.textContent = label;
      else for (const text of button.childNodes) if (text.nodeType === 3 && text.textContent.trim()) { text.textContent = label; break; }
    }
    if (name.textContent.trim() === 'Set nickname') name.textContent = 'Set Nickname';
    for (const button of toolbar.querySelectorAll('.toolbar-group > button, .banner-menu > button')) {
      const title = button.getAttribute('aria-label') || button.textContent.trim();
      if (!button.title) button.title = title;
      if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', title);
    }
    header.classList.add('pahub-unified');
    const style = document.createElement('style'); style.id = 'pahub-banner-toolbar-style';
    style.textContent = CSS; document.head.append(style);
    return true;
  }
  const CSS = \`
  @media screen {
    header.banner.pahub-unified { display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr); gap:12px; min-height:79px; padding:16px 24px; overflow:visible; }
    header.banner.pahub-unified .brand { grid-column:1; min-width:0; }
    header.banner.pahub-unified .brand .logo { width:32px; height:32px; }
    header.banner.pahub-unified .pahub-toolbar { grid-column:2; display:flex; align-items:center; justify-content:center; gap:8px; width:max-content; max-width:100%; }
    header.banner.pahub-unified .toolbar-group { display:flex; flex:0 0 auto; align-items:center; gap:4px; width:max-content; max-width:none; padding:0; margin:0; border:0; border-radius:0; background:none!important; box-shadow:none; }
    header.banner.pahub-unified .toolbar-group + .toolbar-group { border-left:1px solid var(--line); padding-left:8px; }
    header.banner.pahub-unified .banner-actions { grid-column:3; justify-self:end; min-width:0; }
    header.banner.pahub-unified .connection-status { width:auto; max-width:100%; flex:0 1 auto; }
    header.banner.pahub-unified .pahub-toolbar :is(.toolbar-group > button,.banner-menu > button) { display:inline-flex!important; align-items:center; justify-content:center; gap:5px!important; height:32px!important; min-height:32px!important; padding:0 8px!important; margin:0!important; border:1px solid var(--line)!important; border-radius:7px!important; background:var(--surface)!important; color:var(--ink)!important; font:600 10px/1 var(--font)!important; letter-spacing:0!important; text-transform:none!important; white-space:nowrap; box-shadow:none!important; }
    header.banner.pahub-unified .pahub-toolbar :is(.toolbar-group > button,.banner-menu > button):hover { background:var(--green-soft)!important; border-color:var(--green)!important; }
    header.banner.pahub-unified .pahub-toolbar button:focus-visible { outline:2px solid var(--green); outline-offset:2px; }
    header.banner.pahub-unified .pahub-toolbar :is(#save-btn,#save-menu-btn) { background:var(--green)!important; color:var(--surface)!important; border-color:var(--green)!important; }
    header.banner.pahub-unified .banner-save-group { gap:0; }
    header.banner.pahub-unified .pahub-toolbar #save-btn { border-radius:7px 0 0 7px!important; }
    header.banner.pahub-unified .pahub-toolbar #save-menu-btn { width:24px; padding:0!important; border-radius:0 7px 7px 0!important; border-left-color:var(--line)!important; }
    header.banner.pahub-unified .pahub-toolbar svg { width:14px!important; height:14px!important; flex:0 0 14px!important; }
    header.banner.pahub-unified .pahub-toolbar svg.menu-chevron { width:10px!important; height:10px!important; flex:0 0 10px!important; }
    header.banner.pahub-unified .pahub-toolbar button::before { width:14px; height:14px; flex:0 0 14px; }
    header.banner.pahub-unified #save-menu-btn::before { display:none; }
    header.banner.pahub-unified .banner-menu { position:relative; display:flex; flex:0 0 auto; }
    header.banner.pahub-unified .banner-menu .banner-menu-panel { top:calc(100% + 7px); left:0; right:auto; transform:none; background:var(--surface); border-color:var(--line); color:var(--ink); z-index:150; }
    header.banner.pahub-unified .banner-menu-panel button { background:transparent; color:var(--ink); text-transform:none; }
    header.banner.pahub-unified .banner-menu-panel button:hover { background:var(--green-soft); color:var(--ink); }
  }
  @media screen and (max-width:1280px) {
    header.banner.pahub-unified { grid-template-columns:minmax(0,1fr) auto; gap:10px; }
    header.banner.pahub-unified .banner-actions { grid-column:2; grid-row:1; }
    header.banner.pahub-unified .pahub-toolbar { grid-column:1/-1; grid-row:2; justify-self:center; width:auto; flex-wrap:wrap; }
    header.banner.pahub-unified .toolbar-group { flex-wrap:wrap; justify-content:center; max-width:100%; }
  }
  @media screen and (max-width:600px) {
    header.banner.pahub-unified { padding:12px; }
    header.banner.pahub-unified .toolbar-group { width:100%; }
    header.banner.pahub-unified .toolbar-group + .toolbar-group { border-left:0; padding-left:0; }
    header.banner.pahub-unified .connection-status { max-width:90px; }
  }
  @media print { .pahub-toolbar { display:none!important; } }
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
