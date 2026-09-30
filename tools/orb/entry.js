/* global window, document, performance, requestAnimationFrame, cancelAnimationFrame */
// The thinking orb for the setup page, without React: the engine that
// thinking-orbs (MIT, (c) Jakub Antalik) builds its component on, driven by a
// small loop of our own. Bundled by tools/orb/build.mjs into
// packages/core/src/ui/orb.generated.ts.
import { MODE_FRAMES, paintFrame, resolvePreset } from 'thinking-orbs/engine';

window.LingOrb = function mount(canvas, size) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let frameFn = null;
  let opts = null;
  let rate = 1;
  let running = false;
  let raf = 0;
  const draw = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    paintFrame(ctx, frameFn(size, (performance.now() / 1000) * rate, opts), true);
  };
  const loop = () => {
    draw();
    if (running) raf = requestAnimationFrame(loop);
  };
  // Hidden windows draw nothing; the loop resumes when the window shows again.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else if (running) raf = requestAnimationFrame(loop);
  });
  return {
    /** state: a thinking-orbs state; speed: multiplier; moving: animate or hold still. */
    set({ state, speed, moving }) {
      const p = resolvePreset(state, size);
      frameFn = MODE_FRAMES[p.mode];
      opts = p.opts;
      rate = p.speed * speed;
      const go = moving && !reduced;
      if (go && !running) {
        running = true;
        raf = requestAnimationFrame(loop);
      } else if (!go) {
        running = false;
        cancelAnimationFrame(raf);
        draw();
      }
    },
  };
};
