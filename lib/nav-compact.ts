// Restore labels only with spare room, never based on the icon-only width.
export const NAV_EXPAND_SLACK_PX = 24;
export function nextNavCompact(compact: boolean, available: number, expanded: number): boolean {
  if (available <= 0 || expanded <= 0) return compact;
  return compact ? available < expanded + NAV_EXPAND_SLACK_PX : available < expanded;
}

export function observeNavCompact(slot: HTMLElement, nav: HTMLElement, onChange: (compact: boolean) => void) {
  const win = slot.ownerDocument.defaultView!;
  // Noninteractive intrinsic-width copy: still measures labels while live buttons
  // are icon-only, and responds to fonts, role changes and browser zoom.
  const probe = nav.cloneNode(true) as HTMLElement;
  probe.removeAttribute('data-primary-nav');
  probe.setAttribute('data-nav-probe', '');
  probe.setAttribute('data-compact', 'false');
  probe.setAttribute('aria-hidden', 'true');
  probe.inert = true;
  // Measurement must not duplicate interactive selectors or accessibility nodes.
  for (const button of probe.querySelectorAll('button')) {
    const box = slot.ownerDocument.createElement('div');
    box.className = button.className;
    box.append(...button.childNodes);
    button.replaceWith(box);
  }
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:max-content;max-width:none;left:0;top:0';
  slot.append(probe);
  let compact = nav.dataset.compact === 'true';
  let frame = 0;
  const measure = () => {
    frame = 0;
    const style = win.getComputedStyle(slot);
    const available = slot.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const next = nextNavCompact(compact, available, probe.offsetWidth);
    if (next !== compact) { compact = next; onChange(next); }
  };
  const schedule = () => { if (!frame) frame = win.requestAnimationFrame(measure); };
  const observer = new win.ResizeObserver(schedule);
  observer.observe(slot);
  observer.observe(probe);
  measure();
  return () => { observer.disconnect(); win.cancelAnimationFrame(frame); probe.remove(); };
}
