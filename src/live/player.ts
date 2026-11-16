/**
 * The live inspector's browser page.
 *
 * One self-contained document: no CDN, no build step, no framework. It is
 * served by `LiveServer` and speaks one WebSocket to it. Video is decoded with
 * WebCodecs `VideoDecoder` — the browser's own H.264 path — so a frame is one
 * `decode()` call and one `drawImage`, with no MSE, no fMP4 remux and no
 * buffering layer that would add latency we cannot measure.
 */

export const PLAYER_HTML = `<!doctype html>
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
  <label class="switch"><input id="privacy" type="checkbox" checked> mask credentials</label>
  <button id="reconnect" title="Ask the device for a fresh keyframe">Reconnect</button>
</header>
<main>
  <div id="stage">
    <div id="frame">
      <canvas id="screen" width="360" height="780"></canvas>
      <div id="boxes"></div>
    </div>
    <div id="notice">connecting…</div>
  </div>
  <aside>
    <div class="tools">
      <input id="q" type="search" placeholder="filter nodes…" autocomplete="off">
      <button id="copyJson" title="Copy the selected node as JSON">JSON</button>
    </div>
    <div id="list"></div>
    <pre id="detail">Click a node to select it. Click again (or press C) to copy.</pre>
  </aside>
</main>
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
  var qEl = document.getElementById('q');
  var noticeEl = document.getElementById('notice');
  var toastEl = document.getElementById('toast');

  var ws = null;
  var decoder = null;
  var mode = 'none';
  var needKey = true;
  var nodes = [];
  var display = { width: 0, height: 0 };
  var selected = null;
  var privacy = true;
  var frames = 0, fpsAt = 0, lastPts = 0, lastFrameAt = 0;
  var retry = 0, retryTimer = null, stopped = false;

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
    resetDecoder();
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
  }

  function configure(hello) {
    resetDecoder();
    mode = 'none';
    if (hello.width && hello.height) {
      display = { width: hello.width, height: hello.height };
      sizeEl.textContent = hello.width + '×' + hello.height;
    }
    if (!hello.codec) return;
    // MJPEG is what an x86_64 device has instead of an encoder: whole pictures,
    // drawn with createImageBitmap. There is nothing to configure or resync.
    if (hello.codec === 'mjpeg') {
      decoder = null;
      mode = 'mjpeg';
      return;
    }
    mode = 'h264';
    try {
      decoder = new VideoDecoder({ output: onFrame, error: onDecodeError });
      decoder.configure({
        codec: hello.codec,
        description: b64(hello.description),
        optimizeForLatency: true,
        hardwareAcceleration: 'prefer-hardware'
      });
    } catch (e) {
      noticeEl.textContent = 'cannot decode ' + hello.codec + ': ' + e.message;
    }
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
      configure(msg);
      if (msg.state) setBadge(msg.state, msg.reason);
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
    }
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
      if (stopped) return;
      setBadge('reconnecting');
      var wait = Math.min(5000, 400 * Math.pow(2, retry++));
      retryTimer = setTimeout(connect, wait);
    };
    ws.onerror = function () { /* onclose follows */ };
  }

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

  document.addEventListener('keydown', function (ev) {
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
