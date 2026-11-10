// Click-to-open motion of the Project Access Hall: the chosen sheet becomes a closed book that fills the
// screen, then its cover swings open on the left spine while a frosted front clears over the register.
// Only transform and opacity are animated (compositor-friendly, no layout or mask work per frame).

export interface LaunchContext {
  root: HTMLElement;
  card: HTMLElement;
  layer: HTMLElement;
  reduced: boolean;
}

export interface LaunchRun {
  finished: Promise<void>;
  cancel: () => void;
}

/** Timings in ms, exported so tests and docs read the same numbers. */
export const MOTION = {
  /** Other sheets clear away, nearest first. */
  clear: 220,
  clearStagger: 22,
  /** The chosen sheet lifts off and grows into a closed book filling the screen. */
  bookDelay: 40,
  bookGrow: 520,
  /** The cover swings open on its left spine (was 760). */
  coverOpen: 1100,
  /** The frost front crosses the register; it trails the cover edge a little (was 1250). */
  frostClear: 1700,
  /** Share of frostClear the frost holds still while the cover starts to lift. */
  frostHold: 0.05,
  /** Reduced motion: plain fades only. */
  reducedIn: 160,
  reducedOut: 160,
} as const;

const EASE_IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)';
const EASE_SOFT = 'cubic-bezier(0.22, 0.61, 0.36, 1)';

function q<T extends Element = HTMLElement>(el: ParentNode, sel: string) {
  return el.querySelector(sel) as T | null;
}

function visible(el: Element, vh: number) {
  const r = el.getBoundingClientRect();
  return r.bottom > -40 && r.top < vh + 40 && r.width > 0;
}

function collect(ctx: LaunchContext) {
  const vh = window.innerHeight;
  const cards = Array.from(ctx.root.querySelectorAll<HTMLElement>('[data-pl-card]'));
  const others = cards.filter(c => c !== ctx.card && visible(c, vh));
  const chrome = Array.from(ctx.root.querySelectorAll<HTMLElement>('[data-pl-chrome]')).filter(c => visible(c, vh));
  const hidden = [...cards, ...Array.from(ctx.root.querySelectorAll<HTMLElement>('[data-pl-chrome]'))]
    .filter(c => c !== ctx.card && !others.includes(c) && !chrome.includes(c));
  return { others, chrome, hidden };
}

/** Transform that maps a full-viewport box (transform-origin: center) onto rect r. */
function boxTo(r: DOMRect) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const dx = r.left + r.width / 2 - W / 2;
  const dy = r.top + r.height / 2 - H / 2;
  return `translate(${dx}px, ${dy}px) scale(${r.width / W}, ${r.height / H})`;
}

function distanceOrder(els: HTMLElement[], from: DOMRect) {
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  return els.map(el => {
    const r = el.getBoundingClientRect();
    return { el, d: Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy) };
  }).sort((a, b) => a.d - b.d).map(x => x.el);
}

function collector() {
  const anims: Animation[] = [];
  const add = (el: Element | null, frames: Keyframe[], opts: KeyframeAnimationOptions) => {
    if (el) anims.push(el.animate(frames, { fill: 'both', ...opts }));
  };
  const finished = () => Promise.all(anims.map(a => a.finished.catch(() => undefined))).then(() => undefined);
  return { anims, add, finished };
}

/** Click: the room clears sheet by sheet and the chosen sheet becomes a closed book filling the screen. */
export function runLaunch(ctx: LaunchContext): LaunchRun {
  const { anims, add, finished } = collector();
  const book = q(ctx.layer, '.pl-l-book');
  const coverIn = q(ctx.layer, '.pl-l-cover-in');
  const r = ctx.card.getBoundingClientRect();
  const { others, chrome, hidden } = collect(ctx);
  hidden.forEach(el => add(el, [{ opacity: 0 }, { opacity: 0 }], { duration: 1 }));

  if (ctx.reduced) {
    add(book, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.reducedIn, easing: 'linear' });
    add(coverIn, [{ opacity: 1 }, { opacity: 1 }], { duration: 1 });
  } else {
    distanceOrder(others, r).forEach((el, i) => add(el, [
      { opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(22px)' },
    ], { duration: MOTION.clear, delay: Math.min(i, 10) * MOTION.clearStagger, easing: EASE_SOFT }));
    chrome.forEach(el => add(el, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'linear' }));
    add(ctx.card, [{ opacity: 0 }, { opacity: 0 }], { duration: 1 });
    add(book, [
      { transform: boxTo(r), opacity: 1 },
      { transform: 'none', opacity: 1 },
    ], { duration: MOTION.bookGrow, delay: MOTION.bookDelay, easing: EASE_IN_OUT });
    add(coverIn, [{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: MOTION.bookGrow + 40, delay: MOTION.bookDelay, easing: 'linear' });
  }

  return { finished: finished(), cancel: () => anims.forEach(a => a.cancel()) };
}

/**
 * Once the workspace underneath is ready: the cover swings open on its left spine like a book, and a frosted
 * front follows it across the real register, heavy at the moving front and clear on the side already uncovered.
 * Nothing above the frost layers may carry opacity, a filter or a mask, or their backdrop blur sees nothing.
 */
export function runReveal(layer: HTMLElement, reduced: boolean): Promise<void> {
  const { add, finished } = collector();
  const frost = q(layer, '.pl-l-frost');
  if (reduced) {
    add(q(layer, '.pl-l-book'), [{ opacity: 1 }, { opacity: 0 }], { duration: MOTION.reducedOut, easing: 'linear' });
    return finished();
  }
  const frostTiming = { duration: MOTION.frostClear, easing: 'cubic-bezier(0.42, 0, 0.3, 1)' };
  add(frost, [{ visibility: 'visible' }, { visibility: 'visible' }], { duration: MOTION.frostClear });
  // Each frost layer is 300% wide: -50% slides its front 1.5 screens, from all frosted to all clear.
  frost?.querySelectorAll('i').forEach(el => add(el, [
    { transform: 'translate3d(0, 0, 0)' },
    { transform: 'translate3d(0, 0, 0)', offset: MOTION.frostHold },
    { transform: 'translate3d(-50%, 0, 0)' },
  ], frostTiming));
  const coverTiming = { duration: MOTION.coverOpen };
  add(q(layer, '.pl-l-cover'), [
    { transform: 'rotateY(0deg)' },
    { transform: 'rotateY(10deg)', offset: 0.18 },
    { transform: 'rotateY(90deg)' },
  ], { ...coverTiming, easing: 'cubic-bezier(0.5, 0, 0.4, 1)' });
  add(q(layer, '.pl-l-cover-shade'), [{ opacity: 0 }, { opacity: 1 }], { ...coverTiming, easing: 'linear' });
  return finished();
}
