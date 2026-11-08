const SCRIPT_ID = 'pahub-comment-focus';

// Hosted DOM adapter only: use stable data-cid, not renumberable comment-N IDs.
// The v2.6 index Jump click handler already reveals the appropriate page.
const FOCUS_SCRIPT = String.raw`<script id="pahub-comment-focus">
(() => {
  'use strict';
  let observer, expiry, frame;
  function stop() {
    observer?.disconnect(); observer = undefined;
    clearTimeout(expiry);
    cancelAnimationFrame(frame);
  }
  function focusFromHash() {
    stop();
    if (!window.PAHUB) return;
    const match = location.hash.match(/^#comment=([^&]+)(?:&.*)?$/);
    let id;
    try { id = match ? decodeURIComponent(match[1]) : ''; } catch { id = ''; }
    document.querySelectorAll('[data-comment-focus="true"]').forEach(el => {
      el.removeAttribute('data-comment-focus');
    });
    if (!id) return;
    const card = () => [...document.querySelectorAll('#comments article.comment[data-cid]')]
      .find(el => el.dataset.cid === id);
    const entry = () => [...document.querySelectorAll('#index-list [data-action="jump"][data-cid]')]
      .find(el => el.dataset.cid === id);
    function activeInSnapshot() {
      try {
        const data = JSON.parse(document.getElementById('pcf-data')?.textContent || '{}');
        return Array.isArray(data.comments) && data.comments.some(c => c.id === id) &&
          !(data.hub?.tombstones || []).some(t => t.type === 'comment' && t.id === id);
      } catch { return false; }
    }
    let revealed = false;
    function attempt() {
      let target = card();
      if (!target && !revealed) {
        // Unknown/deleted IDs do not change filters, pagination, or document data.
        if (!entry() && !activeInSnapshot()) return;
        const reset = document.getElementById('clear-filters');
        const index = document.getElementById('index-btn');
        const workspace = document.getElementById('workspace');
        if (!reset || !index || !workspace) return;
        revealed = true;
        reset.click();
        target = card();
        if (!target) {
          const wasOpen = workspace.classList.contains('with-index');
          if (!wasOpen) index.click();
          entry()?.click();
          if (!wasOpen && workspace.classList.contains('with-index')) index.click();
          target = card();
        }
      }
      if (!target) return;
      if (!document.getElementById('pahub-comment-focus-style')) {
        const style = document.createElement('style');
        style.id = 'pahub-comment-focus-style';
        style.textContent = '[data-comment-focus="true"]{outline:3px solid #d38c30!important;outline-offset:4px;box-shadow:0 0 0 8px rgba(211,140,48,.18)!important;scroll-margin-top:180px}';
        document.head.append(style);
      }
      target.setAttribute('data-comment-focus', 'true');
      target.scrollIntoView({ block: 'start', behavior: 'auto' });
      stop();
    }
    // Wait for initial/asynchronous render, and run after v2.6's native hash handler.
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(attempt); };
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    expiry = setTimeout(stop, 10000);
    schedule();
  }
  window.addEventListener('hashchange', focusFromHash);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', focusFromHash, { once: true });
  } else focusFromHash();
})();
</script>`;

/** Call only for the hosted response, after hostedHTML has injected window.PAHUB. */
export function commentFocusHTML(html: string): string {
  if (html.includes('id="' + SCRIPT_ID + '"')) return html;
  const bodies = [...html.matchAll(/<\/body\s*>/gi)];
  const closing = bodies.at(-1);
  if (closing?.index === undefined) return html;
  return html.slice(0, closing.index) + FOCUS_SCRIPT + '\n' + html.slice(closing.index);
}
