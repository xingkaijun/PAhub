// Click-to-open motion of the Project Access Hall: the chosen sheet grows into a full-screen loading sheet
// (PG logo, project name, progress line). Once the workspace underneath is ready, that sheet simply fades out
// and leaves the real Inventory in place. Only transform and opacity are animated (compositor-friendly).

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
  /** The chosen sheet lifts off and grows into the loading sheet filling the screen. */
  sheetDelay: 40,
  sheetGrow: 520,
  /** The loading sheet fades away over the ready Inventory (replaces the book opening and frost sweep). */
  fadeOut: 420,
  /** Reduced motion: plain fades only. */
  reducedIn: 160,
  reducedOut: 160,
} as const;

const EASE_IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)';
const EASE_SOFT = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
const EASE_FADE = 'cubic-bezier(0.4, 0, 0.2, 1)';

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

/** Click: the room clears sheet by sheet and the chosen sheet grows into the loading sheet filling the screen. */
export function runLaunch(ctx: LaunchContext): LaunchRun {
  const { anims, add, finished } = collector();
  const sheet = q(ctx.layer, '.pl-l-sheet');
  const sheetIn = q(ctx.layer, '.pl-l-sheet-in');
  const r = ctx.card.getBoundingClientRect();
  const { others, chrome, hidden } = collect(ctx);
  hidden.forEach(el => add(el, [{ opacity: 0 }, { opacity: 0 }], { duration: 1 }));

  if (ctx.reduced) {
    add(sheet, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.reducedIn, easing: 'linear' });
    add(sheetIn, [{ opacity: 1 }, { opacity: 1 }], { duration: 1 });
  } else {
    distanceOrder(others, r).forEach((el, i) => add(el, [
      { opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(22px)' },
    ], { duration: MOTION.clear, delay: Math.min(i, 10) * MOTION.clearStagger, easing: EASE_SOFT }));
    chrome.forEach(el => add(el, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'linear' }));
    add(ctx.card, [{ opacity: 0 }, { opacity: 0 }], { duration: 1 });
    add(sheet, [
      { transform: boxTo(r), opacity: 1 },
      { transform: 'none', opacity: 1 },
    ], { duration: MOTION.sheetGrow, delay: MOTION.sheetDelay, easing: EASE_IN_OUT });
    add(sheetIn, [{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: MOTION.sheetGrow + 40, delay: MOTION.sheetDelay, easing: 'linear' });
  }

  return { finished: finished(), cancel: () => anims.forEach(a => a.cancel()) };
}

/** Once the workspace underneath is ready (already rendered under the sheet): the loading sheet fades out. */
export function runReveal(layer: HTMLElement, reduced: boolean): Promise<void> {
  const { add, finished } = collector();
  add(q(layer, '.pl-l-sheet'), [{ opacity: 1 }, { opacity: 0 }], reduced
    ? { duration: MOTION.reducedOut, easing: 'linear' }
    : { duration: MOTION.fadeOut, easing: EASE_FADE });
  return finished();
}
