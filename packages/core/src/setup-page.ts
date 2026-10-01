import { LOGO_DATA_URI } from './ui/logo.generated.js';
import { ORB_SCRIPT } from './ui/orb.generated.js';

/**
 * The setup page served by `lingspark ui` and shown by the desktop client in a
 * 320×400 window (D-058). One self-contained document: no external scripts,
 * styles, fonts or images, so it works offline. Every string that comes from
 * the machine (names, messages) is inserted as text, never as HTML.
 *
 * Home is the state, one switch, today's numbers and the connected agents;
 * everything else is behind the gear. The orb breathes while checking is on
 * and turns faster while a check is actually running -- the one thing the page
 * can know for certain; it never pretends to know what the agent is doing.
 */

/** A script inlined in the page must not end the <script> element early. */
const inline = (js: string): string => js.replace(/<\//gu, '<\\/');

export const SETUP_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LingSpark · 灵光</title>
<link rel="icon" href="${LOGO_DATA_URI}">
<style>
:root {
  --bg: #000000; --raise: #0f0f0f; --line: #1f1f1f;
  --text: #f2f2f2; --muted: #8c8c8c; --faint: #555555; --ok: #4cd07d; --bad: #ef5350; --pend: #d9a441;
  color-scheme: dark;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); }
body { font: 12.5px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  display: flex; align-items: center; justify-content: center; -webkit-font-smoothing: antialiased; }
.app { width: 320px; height: 400px; display: flex; flex-direction: column; overflow: hidden; position: relative; }
body.in-app .app { width: 100%; height: 100%; }
body:not(.in-app) .app { border: 1px solid var(--line); border-radius: 6px; }

.bar { height: 40px; flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 0 46px 0 14px; -webkit-app-region: drag; user-select: none; }
body.mac-app .bar { padding-left: 78px; }
/* Windows and Linux open the page in a window that brings a title bar of its
   own, standing above the page rather than over it: two headers are one too
   many, so the page draws none there and floats the settings button in the
   corner instead. The Mac shell hides the window's title and puts the traffic
   lights inside the page's bar, so that one stays (D-075). */
body.win-app .bar, body.linux-app .bar { display: none; }
.bar .mark { width: 16px; height: 16px; flex-shrink: 0; margin-right: -2px; }
.bar b { font-size: 12.5px; font-weight: 600; flex: 1; }
.icon { -webkit-app-region: no-drag; width: 26px; height: 26px; border: 0; border-radius: 4px; background: transparent; color: var(--muted);
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; }
.icon:hover { background: var(--raise); color: var(--text); }
/* At the right end of the bar, over the window's corner where the page has no
   bar of its own. The bar leaves the same 36 points of room for it. */
.gear { position: absolute; top: 7px; right: 10px; z-index: 2; }

.view { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.home { flex: 1; display: flex; flex-direction: column; padding: 0 20px; }
.stage { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.orb { width: 48px; height: 48px; opacity: 0.35; transition: opacity 0.4s; }
.orb.live { opacity: 0.7; }
.orb.busy { opacity: 1; }
/* Between two forms of the orb (D-070). */
.orb.fade { opacity: 0; transition: opacity 0.35s; }
.status { display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 15px; font-weight: 600; margin-top: 14px; }
.dot { width: 7px; height: 7px; border-radius: 4px; background: var(--faint); }
.dot.ok { background: var(--ok); }
.sub { color: var(--muted); font-size: 12px; margin: 6px 0 0; max-width: 250px; text-wrap: balance; white-space: pre-line; font-variant-numeric: tabular-nums; }
.stage > .switch { margin-top: 14px; }
.footer { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 40px; border-top: 1px solid var(--line); font-size: 12px; line-height: 1; flex-shrink: 0; }
.footer .label { color: var(--faint); flex-shrink: 0; }
.footer .value { display: flex; align-items: center; gap: 12px; min-width: 0; overflow: hidden; white-space: nowrap; color: var(--muted); }
.conn { display: inline-flex; align-items: center; gap: 6px; }
.conn::before { content: ""; width: 6px; height: 6px; border-radius: 3px; background: var(--ok); flex-shrink: 0; }
/* Connected, but not heard from yet. Amber while the hook lingspark wrote
   demonstrably runs here and all that is left is the agent's restart; red
   when the client ran that command itself and it did not work, which no
   amount of restarting will fix (D-077). */
.conn.wait::before { background: var(--pend); }
.conn.broken::before { background: var(--bad); }
.none { color: var(--faint); }
/* The collapsed "X 等 N 个" lists every connected agent on hover. */
.footer .value.more { cursor: default; }
.pop { position: absolute; right: 0; bottom: 34px; z-index: 5; display: flex; flex-direction: column; gap: 9px;
  padding: 10px 12px; background: #161616; border: 1px solid #2a2a2a; border-radius: 6px; color: var(--text);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6); white-space: nowrap;
  opacity: 0; visibility: hidden; transform: translateY(3px); transition: opacity 0.12s, transform 0.12s, visibility 0.12s; }
.footer .value.more:hover ~ .pop { opacity: 1; visibility: visible; transform: none; }
.pop { width: max-content; max-width: 250px; }
.pop .item { display: flex; flex-direction: column; gap: 4px; }
.pop .hint { white-space: normal; color: var(--muted); font-size: 11.5px; line-height: 1.45; padding-left: 12px; }

.switch { -webkit-app-region: no-drag; width: 28px; height: 16px; border-radius: 8px; border: 0; padding: 0; background: #2b2b2b; position: relative; cursor: pointer; flex-shrink: 0; }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 6px; background: var(--text); transition: left 0.15s; }
.switch[aria-checked="true"] { background: var(--text); }
.switch[aria-checked="true"]::after { left: 14px; background: #000000; }
.switch:disabled { opacity: 0.5; cursor: default; }
.switch.big { width: 42px; height: 24px; border-radius: 12px; }
.switch.big::after { top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 9px; }
.switch.big[aria-checked="true"]::after { left: 21px; }

.settings { flex: 1; overflow-y: auto; padding: 0 14px 14px; }
/* Back sits in the page, not in the title bar. */
.back { display: inline-flex; align-items: center; gap: 4px; margin: 2px 0 2px -2px; border: 0; background: none; padding: 2px;
  color: var(--text); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.back:hover { color: var(--muted); }
.settings::-webkit-scrollbar { width: 0; }
h2 { font-size: 11px; font-weight: 500; color: var(--faint); margin: 12px 2px 4px; letter-spacing: 0.5px; }
.list { background: var(--raise); border-radius: 4px; }
.row { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 5px 10px; border-top: 1px solid var(--line); }
.row:first-child { border-top: 0; }
.grow { flex: 1; min-width: 0; }
.name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.note { color: var(--faint); font-size: 11.5px; }
.off { color: var(--faint); }
input[type=radio] { accent-color: var(--ok); width: 12px; height: 12px; margin: 0; flex-shrink: 0; }
label.row { cursor: pointer; }

/* Today leads; all-time sits under it, quieter. The problem counts open the records (D-070). */
.stats { margin-top: 10px; display: flex; flex-direction: column; align-items: center; gap: 9px; font-variant-numeric: tabular-nums; }
.stat { display: flex; align-items: center; white-space: nowrap; }
.stat .k { font-size: 10px; line-height: 1; padding: 3px 5px; border-radius: 3px; margin-right: 7px; letter-spacing: 0.5px; }
.stat.today { color: #d4d4d4; font-size: 12.5px; }
.stat.today .k { color: var(--text); background: #1f1f1f; }
.stat.total { color: var(--faint); font-size: 11.5px; }
.stat.total .k { color: var(--faint); border: 1px solid #262626; padding: 2px 4px; }
.stat-link { color: inherit; border: 0; background: none; font: inherit; padding: 0; cursor: pointer;
  text-decoration: underline dotted rgba(140, 140, 140, 0.5); text-underline-offset: 3px; }
.stat-link:hover { color: var(--text); text-decoration-color: var(--text); }
.stat-link .chev { font-size: 11px; margin-left: 1px; opacity: 0.8; }

.summary { color: var(--muted); font-size: 11.5px; margin: 2px 2px 8px; font-variant-numeric: tabular-nums; }
.tabs { display: flex; gap: 4px; margin: 0 0 4px; }
.tabs button { border: 0; background: none; color: var(--faint); font: inherit; font-size: 11.5px; padding: 2px 8px; border-radius: 10px; cursor: pointer; }
.tabs button[aria-pressed="true"] { background: #1c1c1c; color: var(--text); }
.card { background: var(--raise); border-radius: 6px; padding: 9px 10px 8px; margin-bottom: 6px; cursor: pointer; }
.card:hover { background: #141414; }
.card .top { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
.card .rule { color: var(--text); font-weight: 600; font-size: 11.5px; }
.card .how { color: var(--faint); }
.card .time { margin-left: auto; color: var(--faint); font-variant-numeric: tabular-nums; }
.quote { margin: 6px 0 4px; padding-left: 8px; border-left: 2px solid #2c2c2c; color: #d6d6d6; font-size: 12px; line-height: 1.55; word-break: break-word; }
.quote mark { background: rgba(239, 83, 80, 0.16); color: #ffb4b2; border-radius: 2px; padding: 0 1px; }
.why { color: var(--muted); font-size: 11.5px; line-height: 1.5; }
.meta { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 11px; color: var(--faint); }
.meta .file { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { margin-left: auto; font-size: 10.5px; padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
.tag.done { color: var(--ok); background: rgba(76, 208, 125, 0.1); }
.tag.open { color: var(--pend); background: rgba(217, 164, 65, 0.1); }
/* Gone with the text: not evidence it was ever put right (D-095). */
.tag.vanished { color: var(--pend); background: rgba(217, 164, 65, 0.1); border: 1px solid rgba(217, 164, 65, 0.35); }
.card .more { display: none; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11.5px; }
.card.open .more { display: block; }
.more b { color: var(--text); font-weight: 500; }
.more .warn { color: var(--pend); margin-bottom: 6px; }
.more .act { margin-top: 6px; display: flex; gap: 12px; }
.more .act button { border: 0; background: none; color: var(--muted); font: inherit; font-size: 11.5px; padding: 0; cursor: pointer; }
.more .act button:hover { color: var(--text); }
.empty { white-space: pre-line; color: var(--faint); text-align: center; margin-top: 80px; font-size: 12px; line-height: 1.8; }

/* Messages take the place of a line that is already there; nothing floats over the panel. */
.sub.notice { color: var(--text); }
.settings-note { color: var(--text); font-size: 12px; margin: 10px 2px 0; white-space: pre-line; }
</style>
</head>
<body>
<div class="app" id="app">
  <div class="bar">
    <img class="mark" src="${LOGO_DATA_URI}" alt="" aria-hidden="true">
    <b>LingSpark · 灵光</b>
  </div>
  <button class="icon gear" id="gear" type="button" aria-label="设置">
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/><circle cx="10.5" cy="4.5" r="1.6" fill="#000"/><circle cx="5.5" cy="8" r="1.6" fill="#000"/><circle cx="9" cy="11.5" r="1.6" fill="#000"/></svg>
  </button>

  <div class="view" id="homeView">
    <div class="home">
      <div class="stage">
        <canvas class="orb" id="orb" width="48" height="48" role="img" aria-label="未开启"></canvas>
        <div class="status"><span class="dot" id="dot"></span><span id="state">正在检查这台电脑…</span></div>
        <p class="sub" id="sub" hidden></p>
        <div class="stats" id="stats" hidden></div>
        <button class="switch big" id="main" type="button" role="switch" aria-checked="false" aria-label="开启检查" disabled></button>
      </div>
      <div class="footer"><span class="label">Agent 工具</span><span class="value" id="agentsLine"></span><div class="pop" id="agentsPop" role="tooltip"></div></div>
    </div>
  </div>

  <div class="view" id="settingsView" hidden>
    <div class="settings">
      <button class="back" id="back" type="button">
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 3 4.5 7l4 4"/></svg>
        设置
      </button>
      <h2>已支持调用的 Agent</h2>
      <div class="list" id="agents"></div>
      <p class="settings-note" id="settingsNote" hidden></p>
    </div>
  </div>

  <div class="view" id="logView" hidden>
    <div class="settings">
      <button class="back" id="logBack" type="button">
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 3 4.5 7l4 4"/></svg>
        拦截记录
      </button>
      <div class="summary" id="logSummary"></div>
      <div class="tabs" id="logTabs">
        <button type="button" data-f="all" aria-pressed="true">全部</button>
        <button type="button" data-f="open" aria-pressed="false">仍在文中</button>
        <button type="button" data-f="done" aria-pressed="false">不再报</button>
      </div>
      <div id="logList"></div>
    </div>
  </div>

</div>
<script>${inline(ORB_SCRIPT)}</script>
<script>
(function () {
  // The token leaves the address bar; this tab keeps it, so a reload finds its way back.
  var token = new URLSearchParams(location.search).get('t') || '';
  try {
    if (token) sessionStorage.setItem('lingspark-token', token);
    else token = sessionStorage.getItem('lingspark-token') || '';
  } catch (e) { /* storage off: a reload shows an empty page */ }
  // The Mac client's window names itself in the user agent (D-061); the
  // Windows and Linux clients ask for a window of their own and say so in the
  // address, because nothing sets a user agent for those (D-074).
  var inWindow = new URLSearchParams(location.search).get('window') === '1' ||
    navigator.userAgent.indexOf('LingSpark/') >= 0;
  history.replaceState(null, '', '/');
  if (inWindow) {
    document.body.classList.add('in-app');
    if (/Mac/.test(navigator.platform)) document.body.classList.add('mac-app');
    if (/Win/.test(navigator.platform)) document.body.classList.add('win-app');
    if (/Linux|X11/.test(navigator.platform)) document.body.classList.add('linux-app');
  }

  /** The file manager each platform shows a revealed file in. */
  function revealLabel() {
    if (/Win/.test(navigator.platform)) return '在资源管理器中显示';
    if (/Linux|X11/.test(navigator.platform)) return '在文件管理器中显示';
    return '在访达中显示';
  }

  function api(route, body) {
    return fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lingspark-token': token },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  // One line per agent reads as a list; "已接入 A、B" says the same in one.
  function summarize(lines) {
    var on = [], off = [], rest = [];
    lines.forEach(function (l) {
      var m = /^(.+)：(已启用|之前已启用|已停用)$/.exec(l);
      if (!m) rest.push(l);
      else if (m[2] === '已停用') off.push(m[1]);
      else on.push(m[1]);
    });
    var out = [];
    if (on.length > 0) out.push('已接入 ' + on.join('、'));
    if (off.length > 0) out.push('已断开 ' + off.join('、'));
    return out.concat(rest);
  }
  // A message shows for a few seconds where the numbers (home) or the end of
  // the list (settings) are, instead of floating over the switch.
  var notice = '';
  var noticeTimer;
  function toast(lines) {
    if (!lines || lines.length === 0) return;
    notice = summarize(lines).join('\\n');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { notice = ''; showNotice(); }, 4000);
    showNotice();
  }
  function showNotice() {
    var note = document.getElementById('settingsNote');
    note.textContent = notice;
    note.hidden = notice === '';
    if (state !== null) renderHome();
  }
  // After any failure the page reads the real state again: what it shows must
  // never drift from what is on disk.
  function failed(e) {
    toast(['出错了：' + e.message]);
    refresh().catch(function () { /* the poll retries */ });
  }
  function busy(button, promise) {
    button.disabled = true;
    return promise.then(function (r) { button.disabled = false; return r; },
      function (e) { button.disabled = false; failed(e); throw e; });
  }

  // The orb: still and dim when off, a slow breath when on, faster while a check runs.
  var canvas = document.getElementById('orb');
  // The engine draws at one of its own sizes (64, 32, 20); CSS shows it at 48.
  var orb = window.LingOrb ? window.LingOrb(canvas, 64) : null;
  // Switched on, the orb changes form every three seconds; while a check
  // runs it holds the "searching" form, so a glance tells work from waiting
  // (D-070).
  var FORMS = ['breathing', 'working', 'connecting', 'weaving', 'composing', 'shaping', 'listening', 'solving'];
  var orbMode = '', form = 0, cycle = 0;
  function setOrb(on, checking) {
    var mode = checking ? 'busy' : on ? 'live' : 'off';
    canvas.className = 'orb' + (mode === 'off' ? '' : ' ' + mode);
    canvas.setAttribute('aria-label', checking ? '正在检查' : on ? '已开启' : '未开启');
    if (mode === orbMode) return;
    orbMode = mode;
    clearInterval(cycle);
    if (!orb) return;
    if (mode === 'busy') { orb.set({ state: 'searching', speed: 1, moving: true }); return; }
    form = 0;
    orb.set({ state: FORMS[0], speed: 0.6, moving: on });
    if (mode !== 'live') return;
    cycle = setInterval(function () {
      if (document.hidden) return;
      canvas.classList.add('fade');
      setTimeout(function () {
        if (orbMode !== 'live') return;
        form = (form + 1) % FORMS.length;
        orb.set({ state: FORMS[form], speed: 0.6, moving: true });
        canvas.classList.remove('fade');
      }, 350);
    }, 3000);
  }

  function show(view) {
    document.getElementById('homeView').hidden = view !== 'home';
    document.getElementById('settingsView').hidden = view !== 'settings';
    document.getElementById('logView').hidden = view !== 'log';
    document.getElementById('gear').hidden = view !== 'home';
  }
  document.getElementById('gear').onclick = function () { show('settings'); };
  document.getElementById('back').onclick = function () { show('home'); };
  document.getElementById('logBack').onclick = function () { show('home'); };

  var state = null;
  var live = { today: { checked: 0, blocked: 0, ever: false, total: { checked: 0, blocked: 0 }, waiting: [], noticed: [] }, checking: false };
  var firstSentence = function (t) { var i = t.indexOf('。'); return i < 0 ? t : t.slice(0, i + 1); };
  function connected() { return state ? state.agents.filter(function (a) { return a.installed; }) : []; }

  function renderHome() {
    var on = connected();
    var canConnect = state.agents.some(function (a) { return a.present && a.installable; });
    var sub = document.getElementById('sub');
    var main = document.getElementById('main');
    main.disabled = on.length === 0 && !canConnect;
    main.setAttribute('aria-checked', on.length > 0 ? 'true' : 'false');
    document.getElementById('dot').className = on.length > 0 ? 'dot ok' : 'dot';
    document.getElementById('state').textContent = on.length > 0 ? '已开启' : '未开启';
    var lines = [];
    if (on.length === 0) {
      lines.push(canConnect
        ? '开启后，Agent 写完的文档会先自动检查一遍，再交给你。'
        : '没有找到能接入的 Agent 工具。装好 Claude Code、Codex、Cursor 或 WorkBuddy 并用过一次后，重新打开 LingSpark。');
    } else {
      // The middle is for what LingSpark has done; what an agent still needs
      // lives in the footer's light (D-066).
    }
    if (notice !== '') lines = [notice];
    renderStats(on.length > 0 && live.today.ever && notice === '');
    sub.textContent = lines.join('\\n');
    sub.className = notice !== '' ? 'sub notice' : 'sub';
    sub.hidden = lines.length === 0;
    setOrb(on.length > 0, on.length > 0 && live.checking);

    // Each connected agent gets a light: green once its hook has run, amber
    // while it waits for a restart (or, Codex, for its hooks to be trusted),
    // red when the hook lingspark wrote cannot run here at all. None connected
    // reads 待连接 in grey. Hovering lists every agent, and what one still
    // needs (D-066, D-077).
    var line = document.getElementById('agentsLine');
    var pop = document.getElementById('agentsPop');
    var waits = function (a) { return live.today.waiting.indexOf(a.id) >= 0; };
    // The agent's hooks are in its config but the agent is not on this machine:
    // a leftover from an uninstall. Nothing will ever call us, so this is not
    // a light that is waiting, it is a light that is wrong (D-081).
    var missing = function (a) { return a.installed && a.found === false; };
    // The client ran that command itself and it answered: our side works, the
    // agent has simply not called yet. Anything else waiting is a real fault.
    var broken = function (a) { return missing(a) || (waits(a) && a.hook !== null && !a.hook.ok); };
    var pending = function (a) { return waits(a) && !broken(a); };
    var light = function (a) { return broken(a) ? 'conn broken' : pending(a) ? 'conn wait' : 'conn'; };
    var anyWaiting = on.some(waits);
    // The summary light (D-068): red while a hook is broken and nobody has
    // read why yet; amber while it is only waiting for a restart.
    var unnoticed = on.filter(function (a) { return broken(a) && live.today.noticed.indexOf(a.id) < 0; });
    var summaryLight = on.some(broken)
      ? (on.every(broken) || unnoticed.length > 0 ? 'conn broken' : 'conn wait')
      : on.some(pending) ? 'conn wait' : 'conn';
    line.classList.remove('more');
    line.replaceChildren.apply(line, on.length > 0
      ? on.map(function (a) { return el('span', light(a), a.name); })
      : [el('span', 'none', '待连接')]);
    // Four names do not fit in 280 pixels: then the first one and a count,
    // with one light that carries the worst state of them.
    var collapsed = on.length > 1 && line.scrollWidth > line.clientWidth;
    if (collapsed) line.replaceChildren(el('span', summaryLight, on[0].name + ' 等 ' + on.length + ' 个'));
    line.onmouseenter = unnoticed.length > 0
      ? function () {
          line.onmouseenter = null;
          api('/api/notice-waiting', { ids: unnoticed.map(function (a) { return a.id; }) })
            .then(function (l) { live = l; renderHome(); })
            .catch(function () { /* stays red; the next hover asks again */ });
        }
      : null;
    if (collapsed || anyWaiting || on.some(missing)) {
      line.classList.add('more');
      pop.replaceChildren.apply(pop, on.map(function (a) {
        var item = el('div', 'item');
        item.appendChild(el('span', light(a), a.name));
        if (broken(a)) {
          item.appendChild(el('span', 'hint', missing(a)
            ? '没找到 ' + a.name + ' 本身，它的配置里还留着 lingspark 的 hook——多半是卸载留下的，关掉即可。'
            : '接不上：' + a.hook.detail));
        } else if (waits(a)) {
          item.appendChild(el('span', 'hint', '已经装好，重新打开 ' + a.name + ' 后生效。'));
        }
        if (a.afterInstall && !missing(a)) item.appendChild(el('span', 'hint', firstSentence(a.afterInstall)));
        return item;
      }));
    } else {
      pop.replaceChildren();
    }
  }

  // Today, then all time; "拦下 N 处问题" opens what was stopped (D-070).
  function renderStats(visible) {
    var box = document.getElementById('stats');
    box.hidden = !visible;
    if (!visible) return;
    var row = function (cls, key, checked, blocked, scope, idle) {
      var r = el('div', 'stat ' + cls);
      r.appendChild(el('span', 'k', key));
      if (idle) { r.appendChild(document.createTextNode(idle)); return r; }
      r.appendChild(document.createTextNode('查了 ' + checked + ' 篇 · '));
      if (blocked === 0) { r.appendChild(document.createTextNode('拦下 0 处问题')); return r; }
      var link = el('button', 'stat-link', '拦下 ' + blocked + ' 处问题');
      link.type = 'button';
      link.appendChild(el('span', 'chev', '›'));
      link.onclick = function () { openLog(scope); };
      r.appendChild(link);
      return r;
    };
    var t = live.today;
    box.replaceChildren(
      row('today', '今天', t.checked, t.blocked, 'today', t.checked === 0 ? '还没查过文档' : ''),
      row('total', '累计', t.total.checked, t.total.blocked, 'all', ''));
  }

  // The records of what was stopped.
  var logScope = 'all', logFilter = 'all', logItems = [];
  var HOW = { write: '写入时拦下', stop: '结束时拦下', review: '结束时自审' };
  // "检查器不再报" is all we know: that a later check did not find it (D-095).
  var STATUS = {
    open: '仍在文中',
    done: '检查器不再报',
    vanished: '不再报（正文同期明显变短）'
  };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var dayKey = function (d) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  function dayLabel(d) {
    var now = new Date(), y = new Date(now.getTime() - 86400000);
    if (dayKey(d) === dayKey(now)) return '今天';
    if (dayKey(d) === dayKey(y)) return '昨天';
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }
  function agentName(id) {
    var a = state && state.agents.filter(function (x) { return x.id === id; })[0];
    return a ? a.name : id;
  }
  function openLog(scope) {
    logScope = scope;
    logFilter = 'all';
    show('log');
    document.getElementById('logList').replaceChildren();
    api('/api/intercepts').then(function (r) { logItems = r.items; renderLog(); }).catch(failed);
  }
  function renderLog() {
    var today = dayKey(new Date());
    var inScope = logItems.filter(function (r) { return logScope === 'all' || dayKey(new Date(r.ts)) === today; });
    var open = inScope.filter(function (r) { return r.status === 'open'; }).length;
    document.getElementById('logSummary').textContent =
      (logScope === 'all' ? '累计 ' : '今天 ') + inScope.length + ' 处 · 不再报 ' + (inScope.length - open) + ' · 仍在文中 ' + open;
    document.querySelectorAll('#logTabs button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-f') === logFilter));
    });
    // "不再报" covers both: gone from the text, gone with the text (D-095).
    var rows = inScope.filter(function (r) {
      return logFilter === 'all' || r.status === logFilter || (logFilter === 'done' && r.status === 'vanished');
    });
    var list = document.getElementById('logList');
    list.replaceChildren();
    if (rows.length === 0) {
      list.appendChild(el('div', 'empty', inScope.length === 0
        ? '这里还没有记录。\\nAgent 写文档时被拦下的问题，会连同原文出现在这里。'
        : '这一类没有记录。'));
      return;
    }
    var lastDay = '';
    rows.forEach(function (r) {
      var d = new Date(r.ts);
      if (logScope === 'all' && dayLabel(d) !== lastDay) { lastDay = dayLabel(d); list.appendChild(el('h2', null, lastDay)); }
      var c = el('div', 'card');
      var top = el('div', 'top');
      top.append(el('span', 'rule', r.ruleName), el('span', 'how', '· ' + (HOW[r.how] || '')), el('span', 'time', pad(d.getHours()) + ':' + pad(d.getMinutes())));
      c.appendChild(top);
      if (r.hit || r.before || r.after) {
        var q = el('div', 'quote');
        q.append(r.before, el('mark', null, r.hit), r.after);
        c.appendChild(q);
      }
      if (r.why) c.appendChild(el('div', 'why', r.why));
      var meta = el('div', 'meta');
      meta.append(el('span', 'file', r.file.split(/[\\\\/]/).pop()), el('span', null, '· ' + agentName(r.agent)),
        el('span', 'tag ' + r.status, STATUS[r.status] || ''));
      c.appendChild(meta);
      var more = el('div', 'more');
      if (r.fix) { var fix = el('div'); fix.append(el('b', null, '建议：'), r.fix); more.appendChild(fix); }
      if (r.suspicious) more.appendChild(el('div', 'warn', '对不上：报告里给的原文片段在文件里找不到，或说已改而文件一字未改（审阅时文件没有被改动）。'));
      if (r.how === 'review') more.appendChild(el('div', null, r.status === 'done' ? 'Agent 自审时报告说已经改掉。' : 'Agent 自审时拿不准，没有改，留给你判断。'));
      else if (r.status === 'vanished') more.appendChild(el('div', null, '后来再检查这个文件已经不报了，但同期正文少了很大一块：可能是那段被删了，而不是改对了——这个检查器分不清。'));
      else if (r.status === 'done') more.appendChild(el('div', null, '后来再检查这个文件时，这个问题已经不在了。'));
      var act = el('div', 'act');
      var openBtn = el('button', null, r.line > 0 ? '打开文件（第 ' + r.line + ' 行）' : '打开文件');
      openBtn.type = 'button';
      openBtn.onclick = function () { api('/api/open', { file: r.file }).catch(failed); };
      var reveal = el('button', null, revealLabel());
      reveal.type = 'button';
      reveal.onclick = function () { api('/api/open', { file: r.file, reveal: true }).catch(failed); };
      act.append(openBtn, reveal);
      more.appendChild(act);
      c.appendChild(more);
      c.onclick = function (e) { if (e.target.tagName !== 'BUTTON') c.classList.toggle('open'); };
      list.appendChild(c);
    });
  }
  document.querySelectorAll('#logTabs button').forEach(function (b) {
    b.onclick = function () { logFilter = b.getAttribute('data-f'); renderLog(); };
  });

  function switchFor(on, label, onChange) {
    var b = el('button', 'switch');
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.setAttribute('aria-label', label);
    b.onclick = function () { busy(b, onChange(!on)).then(done); };
    return b;
  }

  function renderSettings() {
    var agents = document.getElementById('agents');
    agents.replaceChildren();
    state.agents.forEach(function (a) {
      var row = el('div', 'row');
      var cell = el('div', 'grow');
      var name = el('div', 'name', a.name);
      cell.appendChild(name);
      row.appendChild(cell);
      if (!a.installable && !a.installed) {
        name.className = 'name off';
        row.appendChild(el('span', 'note', a.present ? '暂不支持' : '未安装'));
      } else if (!a.present && !a.installed) {
        // Not found: its config directory may be a leftover or another tool's
        // (D-081). The switch stays anyway -- an agent installed somewhere we
        // do not look is still one the person can hook on purpose.
        name.className = 'name off';
        row.appendChild(el('span', 'note', '没找到，可以手动接入'));
        row.appendChild(switchFor(false, a.name, function (on) { return api('/api/agent', { id: a.id, on: on }); }));
      } else {
        if (a.installed && a.afterInstall) cell.appendChild(el('div', 'note', a.afterInstall));
        if (a.installed && a.found === false) {
          cell.appendChild(el('div', 'note', '没找到 ' + a.name + ' 本身，这多半是卸载留下的，关掉即可。'));
        }
        row.appendChild(switchFor(a.installed, a.name, function (on) { return api('/api/agent', { id: a.id, on: on }); }));
      }
      agents.appendChild(row);
    });
  }

  function refresh() {
    return api('/api/state').then(function (s) {
      state = s;
      live = { today: s.today, checking: s.checking };
      renderHome();
      renderSettings();
    });
  }
  function done(r) { toast(r && r.messages); return refresh(); }

  var main = document.getElementById('main');
  main.onclick = function () {
    if (main.getAttribute('aria-checked') === 'true') {
      busy(main, api('/api/disable-all')).then(done);
    } else {
      // One flick connects every agent tool found on this machine.
      main.setAttribute('aria-checked', 'true');
      busy(main, api('/api/enable-all')).then(done);
    }
  };

  // Today's numbers and "a check is running" change while the window is open.
  setInterval(function () {
    if (document.hidden) return;
    // Until the first full state has come in, keep asking for it.
    if (state === null) { refresh().catch(function () { /* next tick */ }); return; }
    api('/api/live').then(function (l) { live = l; renderHome(); }, function () { /* next tick */ });
  }, 2000);

  refresh().catch(function (e) { document.getElementById('state').textContent = '连不上：' + e.message; });
})();
</script>
</body>
</html>
`;
