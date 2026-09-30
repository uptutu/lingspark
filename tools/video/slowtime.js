/* global window, document, performance, requestAnimationFrame */
// Slows a page down by window.__SLOW (tools/video). The recorder cannot take
// sixty 1080p snapshots a second, so the whole scene runs slower instead and
// the frames are stamped with slowed-down time: 60 fps in the video from a
// dozen a second of real snapshots. Everything that moves has to agree:
//   - performance.now and Date.now run slow (the orb draws from them);
//   - setTimeout and setInterval wait longer (the stage's script, typing, the
//     page's own timers);
//   - CSS transitions and animations play at 1/SLOW (checked every frame, so
//     one started since the last frame is caught at once).
// Injected by proxy.mjs at the top of <head>, before any other script runs.
(function (S) {
  if (!(S > 1)) return;
  var realNow = performance.now.bind(performance);
  var t0 = realNow();
  performance.now = function () { return t0 + (realNow() - t0) / S; };
  var realDate = Date.now;
  var d0 = realDate();
  Date.now = function () { return d0 + (realDate() - d0) / S; };
  var st = window.setTimeout, si = window.setInterval;
  window.setTimeout = function (f, d) {
    var rest = Array.prototype.slice.call(arguments, 2);
    return st.apply(window, [f, (d || 0) * S].concat(rest));
  };
  window.setInterval = function (f, d) {
    var rest = Array.prototype.slice.call(arguments, 2);
    return si.apply(window, [f, (d || 0) * S].concat(rest));
  };
  (function slowAnimations() {
    try {
      document.getAnimations().forEach(function (a) { if (a.playbackRate !== 1 / S) a.playbackRate = 1 / S; });
    } catch { /* before the document exists */ }
    requestAnimationFrame(slowAnimations);
  })();
})(window.__SLOW);
