/**
 * The live inspector's browser page.
 *
 * One self-contained document: no CDN, no build step, no framework. It is
 * served by `ViewerServer` and speaks one WebSocket to it. Video is decoded with
 * WebCodecs `VideoDecoder` — the browser's own H.264 path — so a frame is one
 * `decode()` call and one `drawImage`, with no MSE, no fMP4 remux and no
 * buffering layer that would add latency we cannot measure.
 */

const BASE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>uitest live</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --line: #30363d; --ink: #e6edf3;
    --dim: #8b949e; --accent: #2f81f7; --ok: #3fb950; --warn: #d29922; --bad: #f85149;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--ink); font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; flex-direction: column; overflow: hidden;
  }
  header {
    display: flex; align-items: center; gap: 14px; padding: 8px 14px;
    background: var(--panel); border-bottom: 1px solid var(--line); flex: 0 0 auto;
  }
  header .name { font-weight: 600; letter-spacing: .2px; }
  header .spacer { flex: 1; }
  .badge {
    padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .6px; background: #21262d; color: var(--dim);
  }
  .badge.live { background: rgba(63,185,80,.15); color: var(--ok); }
  .badge.starting, .badge.reconnecting { background: rgba(210,153,34,.15); color: var(--warn); }
  .badge.failed, .badge.stopped { background: rgba(248,81,73,.15); color: var(--bad); }
  .stat { color: var(--dim); font-variant-numeric: tabular-nums; }
  .stat b { color: var(--ink); font-weight: 600; }
  label.switch { display: flex; align-items: center; gap: 6px; color: var(--dim); cursor: pointer; user-select: none; }
  label.switch input { accent-color: var(--accent); }
  main { flex: 1; display: flex; min-height: 0; }
  #stage {
    flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center;
    padding: 14px; position: relative; overflow: hidden;
  }
  #frame { position: relative; max-width: 100%; max-height: 100%; }
  canvas { display: block; max-width: 100%; max-height: calc(100vh - 130px); background: #000; border-radius: 6px; }
  #boxes { position: absolute; inset: 0; pointer-events: none; }
  .box {
    position: absolute; border: 1px solid rgba(47,129,247,.55); border-radius: 3px;
    pointer-events: auto; cursor: pointer; transition: background .08s;
  }
  .box:hover { background: rgba(47,129,247,.18); border-color: var(--accent); }
  .box.sel { background: rgba(47,129,247,.25); border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .box.masked {
    background: repeating-linear-gradient(45deg, rgba(13,17,23,.96) 0 6px, rgba(48,54,61,.96) 6px 12px);
    border-color: var(--line);
  }
  .box .tag {
    position: absolute; left: 0; top: -17px; max-width: 240px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; padding: 0 4px; border-radius: 3px 3px 0 0; font-size: 10px;
    background: var(--accent); color: #fff; opacity: 0; transition: opacity .08s;
  }
  .box:hover .tag, .box.sel .tag { opacity: 1; }
  #notice {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: var(--dim); pointer-events: none; text-align: center; padding: 24px;
  }
  /* ---- Takeover ---- */
  #takeover {
    background: var(--warn); border-color: var(--warn); color: #1c1403; font-weight: 600;
  }
  #takeover:hover { filter: brightness(1.08); }
  #takeover.active { background: transparent; color: var(--warn); filter: none; }
  #takeover:disabled { background: #21262d; color: var(--dim); border-color: var(--line); filter: none; }
  #control-state { display: inline-flex; align-items: center; gap: 6px; color: var(--dim); font-size: 11px; }
  #control-state .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); }
  #control-state.mine { color: var(--ok); }
  #control-state.mine .dot { background: var(--ok); animation: pulse 1.6s ease-in-out infinite; }
  #control-state.other { color: var(--warn); }
  #control-state.other .dot { background: var(--warn); }
  #input-ms { color: var(--warn); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
  /* Local feedback only: it says the event was sent, never that the device
     acted. The video remains the only truth. */
  #touch { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
  .ripple {
    position: absolute; width: 24px; height: 24px; margin: -12px 0 0 -12px; border-radius: 50%;
    border: 2px solid var(--warn); opacity: .9; animation: ripple .3s ease-out forwards;
  }
  @keyframes ripple { to { transform: scale(2.2); opacity: 0; } }
  #trail {
    position: absolute; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%;
    background: rgba(210,153,34,.85); display: none;
  }
  .controlled #frame { border: 2px solid var(--warn); box-shadow: inset 0 0 18px rgba(210,153,34,.2); }
  .controlled canvas { cursor: crosshair; touch-action: none; }
  /* The rule has to land on the child: the parent's 'none' loses to
     '.box { pointer-events: auto }'. */
  .controlled .box { pointer-events: none; }
  #keys {
    display: none; flex: 0 0 auto; align-items: center; gap: 8px; padding: 8px 14px;
    background: var(--panel); border-top: 1px solid var(--line);
  }
  .controlled #keys { display: flex; }
  #keys input {
    flex: 1; min-width: 160px; background: var(--bg); color: var(--ink);
    border: 1px solid var(--line); border-radius: 5px; padding: 7px 10px; font: inherit;
  }
  #keys .hint { color: var(--dim); font-size: 11px; }
  #keys .hint.warn { color: var(--warn); }
  @media (max-width: 760px) {
    #keys { flex-wrap: wrap; }
    #keys .hint { flex-basis: 100%; }
  }
  aside {
    flex: 0 0 340px; border-left: 1px solid var(--line); background: var(--panel);
    display: flex; flex-direction: column; min-height: 0;
  }
  aside .tools { padding: 8px; display: flex; gap: 6px; border-bottom: 1px solid var(--line); }
  aside input[type=search] {
    flex: 1; min-width: 0; background: #0d1117; color: var(--ink); border: 1px solid var(--line);
    border-radius: 5px; padding: 5px 8px; font: inherit;
  }
  button {
    background: #21262d; color: var(--ink); border: 1px solid var(--line); border-radius: 5px;
    padding: 5px 9px; font: inherit; cursor: pointer;
  }
  button:hover { border-color: var(--dim); }
  button:disabled { opacity: .5; cursor: default; }
  /* Recording is a state of the device, not of one tab, so it is visible from
     across the room: the same red dot the phone shows. */
  button.rec { border-color: var(--warn); color: var(--warn); }
  button.rec::before {
    content: ''; display: inline-block; width: 7px; height: 7px; margin-right: 6px;
    border-radius: 50%; background: var(--warn); vertical-align: 1px;
  }
  #list { overflow: auto; flex: 1; min-height: 0; }
  .row {
    padding: 6px 10px; border-bottom: 1px solid #21262d; cursor: pointer; display: flex; gap: 8px;
    align-items: baseline;
  }
  .row:hover { background: #1c2128; }
  .row.sel { background: rgba(47,129,247,.16); }
  .row .ref { color: var(--accent); font-variant-numeric: tabular-nums; min-width: 26px; }
  .row .role { color: var(--dim); font-size: 11px; min-width: 54px; }
  .row .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .label.masked { color: var(--warn); font-style: italic; }
  #detail {
    flex: 0 0 auto; max-height: 34%; overflow: auto; margin: 0; padding: 8px 10px;
    border-top: 1px solid var(--line); color: var(--dim); font: 11px/1.5 ui-monospace, Consolas, monospace;
    white-space: pre-wrap; word-break: break-all;
  }
  .toast {
    position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
    background: #21262d; border: 1px solid var(--line); border-radius: 6px; padding: 6px 12px;
    color: var(--ink); opacity: 0; transition: opacity .15s; pointer-events: none;
  }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<header>
  <span class="name">uitest live</span>
  <span id="badge" class="badge">idle</span>
  <span class="stat"><b id="fps">0</b> fps</span>
  <span class="stat"><b id="size">–</b></span>
  <span class="stat" id="latency">–</span>
  <span class="spacer"></span>
  <span id="control-state" class="readonly"><span class="dot"></span><span id="control-text">只读</span></span>
  <span id="input-ms" class="stat" hidden>输入 –</span>
  <button id="takeover" title="接管设备：点击与键盘将发送到手机" aria-label="Take control of the device">接管</button>
  <label class="switch" id="privacy-switch"><input id="privacy" type="checkbox" checked> mask credentials</label>
  <button id="shot" title="Save a masked screenshot of the phone" hidden>Shot</button>
  <button id="record" title="Record an MP4 on the device" hidden>Record</button>
  <button id="reconnect" title="Ask the device for a fresh keyframe">Reconnect</button>
</header>
<main>
  <div id="stage">
    <div id="frame">
      <canvas id="screen" width="360" height="780"></canvas>
      <div id="boxes"></div>
      <div id="touch"><div id="trail"></div></div>
    </div>
    <div id="notice">connecting…</div>
  </div>
  <aside id="side">
    <div class="tools">
      <input id="q" type="search" placeholder="filter nodes…" autocomplete="off">
      <button id="copyJson" title="Copy the selected node as JSON">JSON</button>
    </div>
    <div id="list"></div>
    <pre id="detail">Click a node to select it. Click again (or press C) to copy.</pre>
  </aside>
</main>
<div id="keys" aria-label="Device input">
  <input id="text-input" type="text" placeholder="输入文字后回车发送" autocomplete="off" aria-label="Text to send to the device">
  <button id="send-text" title="Send the text to the device" aria-label="Send text">发送</button>
  <button id="key-back" title="System back" aria-label="Back">返回</button>
  <button id="key-home" title="System home" aria-label="Home">Home</button>
  <button id="key-enter" title="Enter" aria-label="Enter">回车</button>
  <button id="key-delete" title="Delete one character backward" aria-label="Delete">删除</button>
  <span id="text-hint" class="hint">超过 12 字或中文将用粘贴，会覆盖设备剪贴板</span>
</div>
<div id="toast" class="toast"></div>
<script>
(function () {
  'use strict';

  var canvas = document.getElementById('screen');
  var ctx = canvas.getContext('2d', { alpha: false });
  var boxesEl = document.getElementById('boxes');
  var listEl = document.getElementById('list');
  var detailEl = document.getElementById('detail');
  var badgeEl = document.getElementById('badge');
  var fpsEl = document.getElementById('fps');
  var sizeEl = document.getElementById('size');
  var latencyEl = document.getElementById('latency');
  var privacyEl = document.getElementById('privacy');
  var shotEl = document.getElementById('shot');
  var recordEl = document.getElementById('record');
  var qEl = document.getElementById('q');
  var noticeEl = document.getElementById('notice');
  var toastEl = document.getElementById('toast');
  var takeoverEl = document.getElementById('takeover');
  var controlStateEl = document.getElementById('control-state');
  var controlTextEl = document.getElementById('control-text');
  var inputMsEl = document.getElementById('input-ms');
  var touchEl = document.getElementById('touch');
  var trailEl = document.getElementById('trail');
  var textEl = document.getElementById('text-input');
  var sendTextEl = document.getElementById('send-text');
  var textHintEl = document.getElementById('text-hint');

  var ws = null;
  var decoder = null;
  var mode = 'none';
  var needKey = true;
  // The last hello, kept so a decoder that dies mid-stream can be replaced
  // without waiting for the server to announce the format again.
  var lastHello = null;
  var inputMode = 'takeover';
  var listeners = {};

  // Extension API for product pages (the console adds an approval inbox):
  // the page's own protocol stays private, and a product talks through this.
  window.uitestViewer = {
    send: function (message) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
    },
    on: function (type, handler) {
      (listeners[type] = listeners[type] || []).push(handler);
    },
    hello: function () { return lastHello; }
  };

  function emit(msg) {
    var handlers = listeners[msg.type];
    if (!handlers) return;
    for (var i = 0; i < handlers.length; i++) {
      try { handlers[i](msg); } catch (e) { /* a product bug is not a page bug */ }
    }
  }
  var nodes = [];
  var display = { width: 0, height: 0 };
  var selected = null;
  var privacy = true;
  var recording = false;
  var frames = 0, fpsAt = 0, lastPts = 0, lastFrameAt = 0;
  var retry = 0, retryTimer = null, stopped = false;

  // ---- Takeover state ----
  var clientId = null;       // this tab's id, from the private hello
  var controlledId = null;   // the tab the server says is driving, if any
  var controlAt = 0;         // when this tab got control (for the stream hint)
  var warnedNoFrames = false;
  var textTimer = null;
  var composing = false;
  var pointers = {};
  var dragging = false;
  var pinchMode = false;
  var pinchHalf = null;      // last commanded half-distance, for Ctrl+wheel
  var lastPinchAt = 0;
  var lastSent = { x: 0, y: 0 };
  var lastPoint = null;      // last canvas press, the fallback text target
  var lastMoveAt = 0;

  function toast(text) {
    toastEl.textContent = text;
    toastEl.className = 'toast show';
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { toastEl.className = 'toast'; }, 1200);
  }

  function setBadge(state, reason) {
    badgeEl.textContent = state;
    badgeEl.className = 'badge ' + state;
    if (state === 'failed' && reason) noticeEl.textContent = 'failed: ' + reason;
    else if (state === 'live') noticeEl.textContent = '';
    else if (state === 'stopped') noticeEl.textContent = 'stopped';
    else noticeEl.textContent = state + '…';
  }

  function b64(text) {
    var bin = atob(text);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function resetDecoder() {
    if (decoder) {
      try { decoder.close(); } catch (e) {}
      decoder = null;
    }
    needKey = true;
  }

  function requestKey() {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'requestIDR' }));
  }

  function onDecodeError(err) {
    // A decoder that errors is closed and cannot be reused, so put a fresh one
    // in its place before asking for a keyframe — otherwise the request lands
    // on a page that will silently drop every frame that follows.
    resetDecoder();
    if (lastHello) startDecoder(lastHello);
    requestKey();
    noticeEl.textContent = 'decoder: ' + (err && err.message ? err.message : 'error');
  }
  function onFrame(frame) {
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
    frame.close();
    frames++;
    lastFrameAt = performance.now();
    warnedNoFrames = false;
  }

  // Try to open a decoder. The browser picks hardware when it can; asking for
  // it outright is worse than useless, because on a machine without a GPU
  // decoder that request fails the configuration instead of falling back, and
  // the page sits on a black canvas. If even the unhinted decoder refuses, one
  // software retry is the last resort — slower, but a picture.
  function openDecoder(hello, acceleration) {
    var next = new VideoDecoder({ output: onFrame, error: onDecodeError });
    var config = {
      codec: hello.codec,
      description: b64(hello.description),
      optimizeForLatency: true
    };
    if (acceleration) config.hardwareAcceleration = acceleration;
    try {
      next.configure(config);
    } catch (e) {
      try { next.close(); } catch (e2) {}
      throw e;
    }
    decoder = next;
    return true;
  }

  // Open the best decoder this browser will give us: its own choice first,
  // then software as a last resort. Returns true when a decoder is in place.
  function startDecoder(hello) {
    try {
      openDecoder(hello);
      return true;
    } catch (e) {
      try {
        openDecoder(hello, 'prefer-software');
        noticeEl.textContent = 'no hardware decoder, using software';
        return true;
      } catch (e2) {
        decoder = null;
        noticeEl.textContent = 'cannot decode ' + hello.codec + ': ' + e2.message;
        return false;
      }
    }
  }

  function configure(hello) {
    resetDecoder();
    mode = 'none';
    if (hello.width && hello.height) {
      display = { width: hello.width, height: hello.height };
      sizeEl.textContent = hello.width + '×' + hello.height;
    }
    if (!hello.codec) {
      lastHello = null;
      return;
    }
    // MJPEG is what an x86_64 device has instead of an encoder: whole pictures,
    // drawn with createImageBitmap. There is nothing to configure or resync.
    if (hello.codec === 'mjpeg') {
      decoder = null;
      lastHello = null;
      mode = 'mjpeg';
      return;
    }
    mode = 'h264';
    lastHello = hello;
    startDecoder(hello);
  }

  // JPEG frames are decoded one at a time and never overtake each other: a
  // bitmap that resolves after a newer one would show the older picture.
  var jpegBusy = false;
  function onJpeg(blob) {
    if (jpegBusy) return;
    jpegBusy = true;
    createImageBitmap(blob).then(function (bmp) {
      jpegBusy = false;
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      frames++;
      lastFrameAt = performance.now();
      warnedNoFrames = false;
    }, function () {
      jpegBusy = false;
    });
  }

  function onVideo(buf) {
    var dv = new DataView(buf);
    var key = dv.getUint8(0) === 1;
    var pts = dv.getUint32(1);
    lastPts = pts;
    if (mode === 'mjpeg') {
      // The payload is the whole picture.
      onJpeg(new Blob([new Uint8Array(buf, 5)]));
      return;
    }
    if (!decoder) return;
    if (decoder.state !== 'configured') return;
    if (needKey && !key) return;
    if (key) needKey = false;
    // The decoder queue is the only backpressure signal a page has. Past a few
    // frames the picture is already behind; dropping deltas keeps latency low
    // and the next keyframe resynchronises.
    if (!key && decoder.decodeQueueSize > 4) return;
    try {
      decoder.decode(new EncodedVideoChunk({
        type: key ? 'key' : 'delta',
        timestamp: pts * 1000,
        data: new Uint8Array(buf, 5)
      }));
    } catch (e) {
      resetDecoder();
      requestKey();
    }
  }

  function nodeText(n) {
    var q = n.label ? ' "' + n.label.replace(/"/g, '\\\\"') + '"' : '';
    return '[' + n.ref + '] ' + n.role + q + ' @' + n.cx + ',' + n.cy;
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('copied ' + text); }, function () { toast('copy blocked by the browser'); });
      return;
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('copied ' + text); } catch (e) { toast('copy failed'); }
    document.body.removeChild(ta);
  }

  function select(ref, copyIt) {
    selected = ref;
    var found = null;
    for (var i = 0; i < nodes.length; i++) if (nodes[i].ref === ref) found = nodes[i];
    var rows = listEl.querySelectorAll('.row');
    for (var k = 0; k < rows.length; k++) {
      rows[k].className = 'row' + (Number(rows[k].getAttribute('data-ref')) === ref ? ' sel' : '');
    }
    var marks = boxesEl.querySelectorAll('.box');
    for (var m = 0; m < marks.length; m++) {
      marks[m].className = 'box' + (Number(marks[m].getAttribute('data-ref')) === ref ? ' sel' : '')
        + (marks[m].getAttribute('data-masked') === '1' && privacy ? ' masked' : '');
    }
    if (!found) { detailEl.textContent = 'no node [' + ref + ']'; return; }
    detailEl.textContent = JSON.stringify({
      ref: found.ref, role: found.role, label: found.label, masked: !!found.masked,
      rect: { x: found.x, y: found.y, width: found.w, height: found.h },
      center: { x: found.cx, y: found.cy },
      clickable: !!found.clickable, input: !!found.input, scrollable: !!found.scrollable
    }, null, 2);
    if (copyIt) copy(nodeText(found));
  }

  function drawBoxes() {
    boxesEl.innerHTML = '';
    if (!display.width || !display.height) return;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var b = document.createElement('div');
      b.className = 'box' + (n.masked && privacy ? ' masked' : '') + (n.ref === selected ? ' sel' : '');
      b.setAttribute('data-ref', String(n.ref));
      b.setAttribute('data-masked', n.masked ? '1' : '0');
      b.style.left = (n.x / display.width * 100) + '%';
      b.style.top = (n.y / display.height * 100) + '%';
      b.style.width = (n.w / display.width * 100) + '%';
      b.style.height = (n.h / display.height * 100) + '%';
      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = n.ref + ' ' + n.role + (n.label ? ' · ' + n.label : '');
      b.appendChild(tag);
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        select(Number(ev.currentTarget.getAttribute('data-ref')), true);
      });
      boxesEl.appendChild(b);
    }
  }

  function drawList() {
    var needle = (qEl.value || '').toLowerCase();
    listEl.innerHTML = '';
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var text = (n.label || '') + ' ' + n.role + ' ' + n.ref;
      if (needle && text.toLowerCase().indexOf(needle) < 0) continue;
      var row = document.createElement('div');
      row.className = 'row' + (n.ref === selected ? ' sel' : '');
      row.setAttribute('data-ref', String(n.ref));
      var ref = document.createElement('span'); ref.className = 'ref'; ref.textContent = String(n.ref);
      var role = document.createElement('span'); role.className = 'role'; role.textContent = n.role;
      var label = document.createElement('span');
      label.className = 'label' + (n.masked && privacy ? ' masked' : '');
      label.textContent = n.label || '—';
      row.appendChild(ref); row.appendChild(role); row.appendChild(label);
      row.addEventListener('click', function (ev) {
        select(Number(ev.currentTarget.getAttribute('data-ref')), true);
      });
      listEl.appendChild(row);
    }
    if (!listEl.childElementCount) {
      var empty = document.createElement('div');
      empty.className = 'row';
      empty.textContent = nodes.length ? 'no match' : 'waiting for the layout…';
      listEl.appendChild(empty);
    }
  }

  function onNodes(msg) {
    nodes = Array.isArray(msg.nodes) ? msg.nodes : [];
    if (msg.display && msg.display.width) {
      display = msg.display;
      sizeEl.textContent = display.width + '×' + display.height;
    }
    if (typeof msg.privacy === 'boolean') {
      privacy = msg.privacy;
      privacyEl.checked = privacy;
    }
    if (selected !== null && !nodes.some(function (n) { return n.ref === selected; })) selected = null;
    drawBoxes();
    drawList();
  }

  function onText(text) {
    var msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (msg.type === 'hello') {
      if (msg.privacy !== undefined) { privacy = !!msg.privacy; privacyEl.checked = privacy; }
      // A button is shown only when the server said it can serve the request:
      // a video-only mirror has no capture and no recorder behind it.
      shotEl.hidden = !msg.canShot;
      recordEl.hidden = !msg.canRecord;
      // The three product-level switches: a console without an inspector, a
      // page with no takeover, and a privacy switch the product turned off.
      inputMode = msg.mode === 'always' || msg.mode === 'off' ? msg.mode : 'takeover';
      var sideEl = document.getElementById('side');
      if (sideEl && msg.canInspect === false) sideEl.hidden = true;
      var privacySwitchEl = document.getElementById('privacy-switch');
      if (privacySwitchEl && msg.canPrivacy === false) privacySwitchEl.hidden = true;
      takeoverEl.hidden = !msg.canInput || inputMode !== 'takeover';
      setRecording(!!msg.recording);
      // The private greeting names this tab; the broadcast hello does not, so
      // an unnamed hello must not erase the identity we already have.
      if (msg.clientId !== undefined) clientId = msg.clientId;
      if (msg.control) {
        controlledId = msg.control.state === 'controlled' ? (msg.control.by || null) : null;
      }
      updateControlUi();
      configure(msg);
      if (msg.state) setBadge(msg.state, msg.reason);
    } else if (msg.type === 'control') {
      onControl(msg);
    } else if (msg.type === 'nodes') {
      onNodes(msg);
    } else if (msg.type === 'state') {
      setBadge(msg.state, msg.reason);
      if (msg.state === 'live' && decoder) needKey = true;
    } else if (msg.type === 'privacy') {
      privacy = !!msg.value;
      privacyEl.checked = privacy;
      drawBoxes();
      drawList();
    } else if (msg.type === 'record') {
      if (msg.error) toast(msg.error);
      else setRecording(!!msg.recording);
    } else if (msg.type === 'saved') {
      toast(msg.error ? 'failed: ' + msg.error : 'saved ' + msg.path);
    }
    emit(msg);
  }

  // The record button is a toggle: the label says what the next click does, and
  // every tab sees the same state because a recording belongs to the device.
  function setRecording(on) {
    recording = on;
    recordEl.textContent = on ? 'Stop' : 'Record';
    recordEl.className = on ? 'rec' : '';
    recordEl.title = on ? 'Stop and save the MP4' : 'Record an MP4 on the device';
  }

  // ---- Takeover -----------------------------------------------------------

  function isController() {
    return controlledId !== null && controlledId === clientId;
  }

  function canInputNow() {
    return inputMode === 'always' || isController();
  }

  function updateControlUi() {
    if (inputMode === 'always') {
      // There is no controller to hand off to; the page is always able to
      // send input, and the takeover button has nothing to toggle.
      takeoverEl.hidden = true;
      document.body.classList.add('controlled');
      controlStateEl.className = 'mine';
      controlTextEl.textContent = '输入已开启';
      inputMsEl.hidden = false;
      return;
    }
    var mine = isController();
    document.body.classList.toggle('controlled', mine);
    if (!mine) resetLocalInput();
    takeoverEl.textContent = mine ? '退出接管' : '接管';
    takeoverEl.className = mine ? 'active' : '';
    takeoverEl.disabled = controlledId !== null && !mine;
    takeoverEl.title = controlledId !== null && !mine
      ? '另一个页面正在操作'
      : (mine ? '退出接管，回到只读' : '接管设备：点击与键盘将发送到手机');
    if (controlledId === null) {
      controlStateEl.className = 'readonly';
      controlTextEl.textContent = '只读';
    } else if (mine) {
      controlStateEl.className = 'mine';
      controlTextEl.textContent = '接管中';
    } else {
      controlStateEl.className = 'other';
      controlTextEl.textContent = '他人接管';
    }
    inputMsEl.hidden = !mine;
    if (!mine) inputMsEl.textContent = '输入 –';
  }

  function resetLocalInput() {
    pointers = {};
    dragging = false;
    pinchMode = false;
    pinchHalf = null;
    hideTrail();
    clearTimeout(textTimer);
    textTimer = null;
    textEl.value = '';
    updateTextHint();
  }

  function onControl(msg) {
    var wasMine = isController();
    var previousId = controlledId;
    controlledId = msg.state === 'controlled' ? (msg.clientId || null) : null;
    var mine = isController();
    if (mine && !wasMine) {
      controlAt = performance.now();
      warnedNoFrames = false;
    }
    updateControlUi();
    if (mine && !wasMine) toast('已接管设备');
    else if (!mine && wasMine) toast('已退出接管');
    else if (msg.state === 'controlled' && !mine && previousId === null) toast('另一个页面正在操作');
    if (msg.reason === 'busy') toast('另一个页面正在操作');
    else if (msg.reason === 'error') toast('输入通道不可用：' + (msg.message || 'error'));
    if (msg.stats && mine && typeof msg.stats.p50 === 'number') {
      // p50/p95 cover touch ops only. Scrolls and pastes are an order of
      // magnitude slower, so folding them in would report a number that
      // describes no gesture — say how many were left out instead.
      var slow = typeof msg.stats.slow === 'number' ? msg.stats.slow : 0;
      if (msg.stats.n === 0 && slow > 0) {
        inputMsEl.textContent = '输入 — (' + slow + ' 次慢操作)';
      } else {
        inputMsEl.textContent =
          '输入 ' + Math.round(msg.stats.p50) + ' ms' + (slow > 0 ? ' (+' + slow + ' 次慢操作)' : '');
      }
    }
  }

  // In takeover mode only the controlling tab's gestures reach the wire; a
  // stale read-only tab cannot inject anything. always mode is the product's
  // explicit decision to let every tab drive.
  function sendInput(msg) {
    if (!canInputNow() || !ws || ws.readyState !== 1) return false;
    msg.type = 'input';
    ws.send(JSON.stringify(msg));
    return true;
  }

  // The picture is the decoded frame, which is not always the display: a
  // --scale 2 cast and every MJPEG device (x86_64 emulators) deliver half
  // the size. Input is in device pixels, so it is converted against the
  // display, not the frame — otherwise every tap lands in the top-left
  // quadrant of the phone.
  function viewSize() {
    if (display.width > 0 && display.height > 0) return display;
    return { width: canvas.width, height: canvas.height };
  }

  function devicePoint(ev) {
    var r = canvas.getBoundingClientRect();
    var view = viewSize();
    if (!r.width || !r.height) return { x: 0, y: 0 };
    var x = Math.round((ev.clientX - r.left) * view.width / r.width);
    var y = Math.round((ev.clientY - r.top) * view.height / r.height);
    return {
      x: Math.max(0, Math.min(view.width - 1, x)),
      y: Math.max(0, Math.min(view.height - 1, y))
    };
  }

  function localPoint(ev) {
    var r = touchEl.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  function ripple(ev) {
    var p = localPoint(ev);
    var dot = document.createElement('div');
    dot.className = 'ripple';
    dot.style.left = p.x + 'px';
    dot.style.top = p.y + 'px';
    touchEl.appendChild(dot);
    setTimeout(function () {
      if (dot.parentNode) dot.parentNode.removeChild(dot);
    }, 320);
  }

  function showTrail(ev) {
    var p = localPoint(ev);
    trailEl.style.left = p.x + 'px';
    trailEl.style.top = p.y + 'px';
    trailEl.style.display = 'block';
  }

  function hideTrail() {
    trailEl.style.display = 'none';
  }

  function pinchState() {
    var ids = Object.keys(pointers);
    if (ids.length < 2) return null;
    var a = pointers[ids[0]];
    var b = pointers[ids[1]];
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    var max = Math.min(viewSize().width, viewSize().height) / 2;
    return {
      cx: Math.round((a.x + b.x) / 2),
      cy: Math.round((a.y + b.y) / 2),
      half: Math.max(20, Math.min(max, Math.round(Math.sqrt(dx * dx + dy * dy) / 2)))
    };
  }

  function sendPinch(force) {
    var s = pinchState();
    if (!s) return;
    var now = performance.now();
    if (!force) {
      if (now - lastPinchAt < 120) return;
      if (pinchHalf !== null && Math.abs(s.half - pinchHalf) < 2) return;
    }
    if (!sendInput({ action: 'pinch', cx: s.cx, cy: s.cy, half: s.half })) return;
    pinchHalf = s.half;
    lastPinchAt = now;
  }

  function onPointerDown(ev) {
    if (!canInputNow()) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    var p = devicePoint(ev);
    var count = Object.keys(pointers).length;
    pointers[ev.pointerId] = p;
    lastPoint = p;
    ripple(ev);
    if (count === 0) {
      dragging = true;
      pinchMode = false;
      pinchHalf = null;
      lastMoveAt = 0;
      lastSent = p;
      showTrail(ev);
      sendInput({ action: 'down', x: p.x, y: p.y });
    } else if (count === 1) {
      // The device holds one pointer at a time. End the drag at the last sent
      // point, then drive the scale with two fingers.
      dragging = false;
      hideTrail();
      sendInput({ action: 'up', x: lastSent.x, y: lastSent.y });
      pinchMode = true;
      pinchHalf = null;
      lastPinchAt = 0;
      sendPinch(true);
    }
  }

  function onPointerMove(ev) {
    if (!(ev.pointerId in pointers)) return;
    var p = devicePoint(ev);
    pointers[ev.pointerId] = p;
    lastPoint = p;
    if (pinchMode) { sendPinch(false); return; }
    if (!dragging) return;
    var now = performance.now();
    if (now - lastMoveAt < 16) return;
    lastMoveAt = now;
    lastSent = p;
    showTrail(ev);
    sendInput({ action: 'move', x: p.x, y: p.y });
  }

  function onPointerUp(ev) {
    if (!(ev.pointerId in pointers)) return;
    var p = devicePoint(ev);
    delete pointers[ev.pointerId];
    var left = Object.keys(pointers).length;
    hideTrail();
    if (pinchMode) {
      // No finger lifts back into a drag: the next gesture starts fresh.
      if (left < 2) { pinchMode = false; pinchHalf = null; }
      return;
    }
    if (dragging) {
      dragging = false;
      sendInput({ action: 'up', x: p.x, y: p.y });
    }
  }

  function onWheel(ev) {
    if (!canInputNow()) return;
    ev.preventDefault();
    if (ev.ctrlKey) {
      var p = devicePoint(ev);
      var max = Math.min(viewSize().width, viewSize().height) / 2;
      var base = pinchHalf === null ? Math.max(20, max / 3) : pinchHalf;
      var half = Math.round(Math.max(20, Math.min(max, base * Math.exp(-ev.deltaY * 0.002))));
      if (pinchHalf !== null && Math.abs(half - pinchHalf) < 2) return;
      if (sendInput({ action: 'pinch', cx: p.x, cy: p.y, half: half })) {
        pinchHalf = half;
        lastPinchAt = performance.now();
      }
      return;
    }
    var pt = devicePoint(ev);
    // Positive deltaY is "scroll down" in the browser; the device uses the
    // same convention.
    sendInput({ action: 'wheel', x: pt.x, y: pt.y, dy: ev.deltaY });
  }

  function flushText() {
    clearTimeout(textTimer);
    textTimer = null;
    // Mid-composition the field holds the IME's pinyin, not the person's
    // characters. Enter to pick a candidate, Esc and the 回车 button all call
    // this; sending now would put "hongmeng" on the phone and lose 鸿蒙. The
    // compositionend that follows schedules the real flush.
    if (composing) return;
    var text = textEl.value;
    if (!text) return;
    textEl.value = '';
    updateTextHint();
    var msg = { action: 'text', text: text };
    if (lastPoint) { msg.x = lastPoint.x; msg.y = lastPoint.y; }
    sendInput(msg);
  }

  function scheduleFlush() {
    clearTimeout(textTimer);
    textTimer = setTimeout(flushText, 300);
  }

  function updateTextHint() {
    var value = textEl.value;
    var paste = /[^\\x00-\\x7F]/.test(value) || value.length > 12;
    textHintEl.className = 'hint' + (paste ? ' warn' : '');
  }

  function bindSystemKey(id, name) {
    var el = document.getElementById(id);
    el.addEventListener('click', function () {
      // While the IME is composing, the field holds pinyin, not the person's
      // characters, and the candidate picker owns Enter. Sending the key now
      // would submit "hongmeng" — or submit the candidate and then also send
      // Enter, closing what it just opened.
      if (composing) return;
      // Text typed in the last 300 ms is still buffered. The key must not
      // overtake it: Back or Home would land on a screen that does not have
      // the text yet, and the text would then arrive on whatever is showing.
      // Spec §6.4 fixes the order — flush, then the key.
      flushText();
      sendInput({ action: 'key', key: name });
      el.disabled = true;
      setTimeout(function () { el.disabled = false; }, 150);
    });
  }

  function connect() {
    clearTimeout(retryTimer);
    stopped = false;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/live');
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () {
      retry = 0;
      noticeEl.textContent = 'starting…';
      ws.send(JSON.stringify({ type: 'privacy', value: privacy }));
    };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') onText(ev.data);
      else onVideo(ev.data);
    };
    ws.onclose = function () {
      resetDecoder();
      // The socket's identity is gone with it; the server has already
      // released this tab. Do not wait for a broadcast that cannot arrive.
      controlledId = null;
      updateControlUi();
      if (stopped) return;
      setBadge('reconnecting');
      var wait = Math.min(5000, 400 * Math.pow(2, retry++));
      retryTimer = setTimeout(connect, wait);
    };
    ws.onerror = function () { /* onclose follows */ };
  }

  // ---- Takeover wiring ----------------------------------------------------

  takeoverEl.addEventListener('click', function () {
    if (!ws || ws.readyState !== 1) { toast('not connected'); return; }
    if (isController()) {
      // Flush before leaving: the buffered text belongs to this takeover.
      flushText();
      ws.send(JSON.stringify({ type: 'control', action: 'release' }));
    } else {
      ws.send(JSON.stringify({ type: 'control', action: 'take' }));
    }
  });

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('lostpointercapture', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  textEl.addEventListener('input', function () {
    updateTextHint();
    if (composing) return;
    scheduleFlush();
  });
  textEl.addEventListener('compositionstart', function () {
    composing = true;
    clearTimeout(textTimer);
    textTimer = null;
  });
  textEl.addEventListener('compositionend', function () {
    composing = false;
    scheduleFlush();
  });
  textEl.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    // While the IME owns the keyboard, Enter picks a candidate; the phone must
    // not also receive an Enter, which would submit the screen underneath.
    if (composing) return;
    ev.preventDefault();
    flushText();
    sendInput({ action: 'key', key: 'enter' });
  });
  sendTextEl.addEventListener('click', function () {
    flushText();
    textEl.focus();
  });
  bindSystemKey('key-back', 'back');
  bindSystemKey('key-home', 'home');
  bindSystemKey('key-enter', 'enter');
  bindSystemKey('key-delete', 'delete');

  // A closed tab is a release: the socket close tells the server, which lifts
  // any held pointer and broadcasts the read-only state to the other tabs.
  window.addEventListener('pagehide', function () {
    try { if (ws) ws.close(); } catch (e) {}
  });

  updateControlUi();

  privacyEl.addEventListener('change', function () {
    privacy = privacyEl.checked;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'privacy', value: privacy }));
    drawBoxes();
    drawList();
  });

  qEl.addEventListener('input', drawList);

  document.getElementById('reconnect').addEventListener('click', function () {
    // Re-sync the picture: drop the decoder and ask for a fresh keyframe. The
    // socket and the cast stay as they are, so this costs one frame, not a
    // device restart.
    if (!ws || ws.readyState !== 1) { connect(); return; }
    resetDecoder();
    requestKey();
  });

  document.getElementById('copyJson').addEventListener('click', function () {
    if (selected === null) { toast('select a node first'); return; }
    var n = nodes.filter(function (x) { return x.ref === selected; })[0];
    if (n) copy(JSON.stringify(n));
  });

  shotEl.addEventListener('click', function () {
    if (!ws || ws.readyState !== 1) { toast('not connected'); return; }
    // Disable for the round trip: the capture is a device read plus an encode,
    // and a second click would queue a second file for no reason.
    shotEl.disabled = true;
    ws.send(JSON.stringify({ type: 'shot' }));
    setTimeout(function () { shotEl.disabled = false; }, 1500);
  });

  recordEl.addEventListener('click', function () {
    if (!ws || ws.readyState !== 1) { toast('not connected'); return; }
    ws.send(JSON.stringify({ type: 'record', action: recording ? 'stop' : 'start' }));
  });

  document.addEventListener('keydown', function (ev) {
    // Esc works even from the text field: it is the page's one shortcut.
    if (ev.key === 'Escape' && isController()) {
      ev.preventDefault();
      flushText();
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'control', action: 'release' }));
      return;
    }
    if (ev.target && /input|textarea/i.test(ev.target.tagName)) return;
    if ((ev.key === 'c' || ev.key === 'C') && selected !== null) {
      var n = nodes.filter(function (x) { return x.ref === selected; })[0];
      if (n) copy(nodeText(n));
    }
  });

  setInterval(function () {
    var now = performance.now();
    if (!fpsAt) { fpsAt = now; frames = 0; return; }
    var span = now - fpsAt;
    if (span >= 500) {
      fpsEl.textContent = (frames * 1000 / span).toFixed(0);
      frames = 0;
      fpsAt = now;
    }
    latencyEl.textContent = lastFrameAt ? Math.max(0, Math.round(now - lastFrameAt)) + ' ms idle' : '–';
    // A silent stream does not prove the input lane is dead, so warn and let
    // the person decide; never drop control on the page's own initiative.
    if (isController() && !warnedNoFrames) {
      var base = Math.max(lastFrameAt, controlAt);
      if (base && now - base > 30000) {
        warnedNoFrames = true;
        toast('画面已断开，可退出接管');
      }
    }
  }, 250);

  if (typeof VideoDecoder === 'undefined') {
    noticeEl.textContent = 'This browser has no WebCodecs VideoDecoder. Use Chrome or Edge 94+.';
  } else {
    connect();
  }
})();
</script>
</body>
</html>
`;

/**
 * Escapes text for interpolation into markup. The title is the caller's, so a
 * product name with `<` must render, not become a tag.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const EXTRA_MARK = "</body>";

/**
 * The built-in page, optionally retitled or extended.
 *
 * `extraHtml` is product markup placed before `</body>`; `extraScript` runs
 * after the page's own script and talks to it through `window.uitestViewer`.
 * Injecting through a function replacement keeps `$&` in a product's text from
 * being read as a replacement pattern.
 */
export function renderPlayerPage(
  opts: { title?: string; extraHtml?: string; extraScript?: string } = {},
): string {
  const title = escapeHtml(opts.title ?? "uitest viewer");
  let html = BASE.replace("<title>uitest live</title>", () => `<title>${title}</title>`);
  if (opts.extraHtml) html = html.replace(EXTRA_MARK, () => `${opts.extraHtml}\n${EXTRA_MARK}`);
  if (opts.extraScript) {
    html = html.replace(EXTRA_MARK, () => `<script>${opts.extraScript}</script>\n${EXTRA_MARK}`);
  }
  return html;
}

export const PLAYER_HTML = renderPlayerPage();
