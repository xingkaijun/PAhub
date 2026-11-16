import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {nextNavCompact, observeNavCompact} from '../../lib/nav-compact';

test('navigation compacts only on overflow and restores with 24px hysteresis', () => {
  assert.equal(nextNavCompact(false, 800, 800), false);
  assert.equal(nextNavCompact(false, 799, 800), true);
  assert.equal(nextNavCompact(true, 800, 800), true);
  assert.equal(nextNavCompact(true, 823, 800), true);
  assert.equal(nextNavCompact(true, 824, 800), false);
  assert.equal(nextNavCompact(true, 0, 800), true);
  assert.equal(nextNavCompact(false, 0, 0), false);
});

test('observer measures expanded copy, responds to container/font changes and cleans up', () => {
  const dom = new JSDOM('<div style="padding:0 16px"><nav data-primary-nav data-compact="false"><button title="Guide" aria-label="Guide"><span>Guide</span></button></nav></div>');
  const win = dom.window, slot = win.document.querySelector('div')!, nav = slot.querySelector('nav')!;
  let width = 700, expanded = 800, resized!: () => void, disconnected = false;
  const frames = new Map<number, FrameRequestCallback>();
  win.requestAnimationFrame = callback => { frames.set(1, callback); return 1; };
  win.cancelAnimationFrame = id => { frames.delete(id); };
  win.ResizeObserver = class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() { disconnected = true; } } as any;
  Object.defineProperty(slot, 'clientWidth', {get: () => width});
  Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', {get: () => expanded});
  const changes: boolean[] = [];
  const stop = observeNavCompact(slot as any, nav as any, value => changes.push(value));
  const probe = slot.querySelector('[data-nav-probe]')!;
  assert.equal(probe.getAttribute('aria-hidden'), 'true');
  assert.equal(probe.hasAttribute('data-primary-nav'), false);
  assert.equal(probe.getAttribute('data-compact'), 'false');
  assert.equal(probe.querySelectorAll('button').length, 0);
  assert.equal(slot.querySelectorAll('button[title=Guide]').length, 1);
  assert.deepEqual(changes, [true]);
  const flush = () => { resized(); const callback = frames.get(1)!; frames.clear(); callback(0); };
  width = 840; flush(); // 808 content pixels, insufficient expansion slack
  assert.deepEqual(changes, [true]);
  width = 856; flush(); assert.deepEqual(changes, [true, false]);
  expanded = 900; flush(); assert.deepEqual(changes, [true, false, true]);
  resized(); stop();
  assert.equal(disconnected, true); assert.equal(frames.size, 0);
  assert.equal(slot.querySelector('[data-nav-probe]'), null);
  dom.window.close();
});
