/**
 * The console's own markup and script, appended to core's player page.
 *
 * Everything the console adds is a product layer: the stream, the node table,
 * the privacy switch and the takeover arbitration all stay in core's page and
 * server. This file adds the two things only a person-facing product has — the
 * approval inbox and an explicit hold/resume button — plus a read-only view of
 * what the agent has been doing.
 *
 * Rows are built by the same functions the tests drive: they are serialised
 * into the page so there is one implementation of "how an approval row looks"
 * and one place that escapes device-side text.
 */

export interface ApprovalRow {
  id: string;
  /** The 8-character device hash the approval is filed under. */
  tag: string;
  command: string;
  bundle?: string;
  task?: string;
  rule?: string;
  status: string;
  expiresInMs: number;
}

export interface ActivityRow {
  at: string;
  step: number;
  command: string;
  status: string;
  text: string;
}

/** Escapes text for interpolation into markup. Device text is untrusted. */
export function escapeHtml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `42000` → `42s`; a minute or more reads `1m05s`. */
export function formatSeconds(ms: number): string {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (total < 60) return `${total}s`;
  const rest = total % 60;
  return `${Math.floor(total / 60)}m${rest ? String(rest).padStart(2, "0") : ""}s`;
}

/** One approval: what it is, where, how long is left, and the two answers. */
export function renderApprovalRow(row: ApprovalRow): string {
  const where = [row.bundle || "unknown app", row.task ? `task ${row.task}` : ""]
    .filter(Boolean)
    .join(" · ");
  // An answered request keeps its row so the person sees their answer land,
  // but the answers and the countdown go: the buttons would suggest it is
  // still open, and "expires in 42s" is about a window that no longer matters.
  const open = row.status === "pending";
  const tail = open
    ? ` · expires in ${formatSeconds(row.expiresInMs)}`
    : "";
  return (
    `<div class="row" data-id="${escapeHtml(row.id)}">` +
    `<div class="head"><code>${escapeHtml(row.id)}</code> ` +
    `<b>${escapeHtml(row.command)}</b> ` +
    `<span class="rule">${escapeHtml(row.rule ?? "-")}</span> ` +
    `<span class="status">${escapeHtml(row.status)}</span></div>` +
    `<div class="meta">${escapeHtml(where)} · device ${escapeHtml(row.tag)}${tail}</div>` +
    (open
      ? `<div class="actions">` +
        `<select data-scope aria-label="How long this answer lasts">` +
        `<option value="once">once</option><option value="task">this task</option>` +
        `<option value="always">always</option></select>` +
        `<button data-allow>Allow</button><button data-deny>Deny</button></div>`
      : "") +
    `</div>`
  );
}

/** One recorded step. Text is the CLI's own output, escaped. */
export function renderActivityRow(row: ActivityRow): string {
  return (
    `<div class="row">` +
    `<div class="head"><b>${escapeHtml(row.command)}</b> ` +
    `<span class="rule">${escapeHtml(row.status)}</span> ` +
    `<span class="meta">step ${escapeHtml(String(row.step))}</span></div>` +
    `<div class="meta">${escapeHtml(row.text).slice(0, 400)}</div>` +
    `</div>`
  );
}

/**
 * The row builders as page source.
 *
 * Serialising the functions keeps the tested implementation and the shipped
 * one identical: a second copy inside a template string is the copy that
 * forgets an escape.
 */
const CLIENT_ROWS = [escapeHtml, formatSeconds, renderApprovalRow, renderActivityRow]
  .map((fn) => fn.toString())
  .join("\n");

/**
 * The page's markup and styles.
 *
 * The viewer's stylesheet is loaded on this page too, and it defines a global
 * `.row { display: flex }` for its node table. The console's rows are three
 * stacked blocks (head, meta, actions), so they are reset to `display: block`
 * below — as flex children they sat side by side and the meta line was
 * squeezed to one character per line, which an acceptance screenshot caught.
 */
export const CONSOLE_HTML = `
<style>
  #console-panel {
    position: fixed; left: 14px; top: 56px; width: 360px; max-height: calc(100% - 90px);
    display: flex; flex-direction: column; background: var(--panel);
    border: 1px solid var(--line); border-radius: 8px; overflow: hidden;
    box-shadow: 0 8px 30px rgba(0,0,0,.45); z-index: 5;
  }
  #console-panel header {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    background: #1c2128; border-bottom: 1px solid var(--line); font-weight: 600;
  }
  #console-panel header .spacer { flex: 1; }
  #console-panel section { border-bottom: 1px solid var(--line); min-height: 0; }
  #console-panel h3 {
    margin: 0; padding: 6px 10px; font-size: 11px; letter-spacing: .6px;
    text-transform: uppercase; color: var(--dim); border-bottom: 1px solid #21262d;
  }
  #console-panel .list { max-height: 200px; overflow: auto; }
  #console-panel .row { display: block; padding: 7px 10px; border-bottom: 1px solid #21262d; }
  #console-panel .row:last-child { border-bottom: 0; }
  #console-panel .head { display: flex; gap: 6px; align-items: baseline; }
  #console-panel .head code { color: var(--accent); font-size: 11px; }
  #console-panel .rule { color: var(--warn); font-size: 11px; }
  #console-panel .status { color: var(--dim); font-size: 11px; }
  #console-panel .meta { color: var(--dim); font-size: 11px; margin-top: 2px; word-break: break-word; }
  #console-panel .actions { display: flex; gap: 6px; margin-top: 6px; }
  #console-panel .actions select {
    background: var(--bg); color: var(--ink); border: 1px solid var(--line);
    border-radius: 5px; padding: 3px 6px; font: inherit; font-size: 11px;
  }
  #console-panel .actions button { padding: 3px 9px; font-size: 11px; }
  #console-panel .empty { padding: 10px; color: var(--dim); font-size: 12px; }
  #held-banner {
    display: none; padding: 7px 10px; background: rgba(248,81,73,.16);
    color: var(--bad); font-weight: 600; font-size: 12px;
  }
  #held-banner.on { display: block; }
  #locked-banner {
    display: none; padding: 7px 10px; background: rgba(210,153,34,.18);
    color: #d29922; font-weight: 600; font-size: 12px;
  }
  #locked-banner.on { display: block; }
  #hold.on { border-color: var(--bad); color: var(--bad); }
  @media (max-width: 900px) {
    #console-panel { display: none; }
  }
</style>
<div id="console-panel" aria-label="Console">
  <header><span>uitest-console</span><span class="spacer"></span>
    <button id="hold" title="Take the phone; agent commands stop with lease_held">Hold</button>
  </header>
  <div id="held-banner">You have the phone · agents are paused</div>
  <div id="locked-banner">The phone is locked · unlock it to see the screen</div>
  <section id="inbox">
    <h3>Approvals waiting for you</h3>
    <div id="approvals-list" class="list"><div class="empty">none</div></div>
  </section>
  <section id="activity">
    <h3>Recent activity</h3>
    <div id="activity-list" class="list"><div class="empty">none</div></div>
  </section>
</div>
`;

export const CONSOLE_SCRIPT = `
(function () {
  'use strict';
  var viewer = window.uitestViewer;
  if (!viewer) return;

  ${CLIENT_ROWS}

  var approvalsEl = document.getElementById('approvals-list');
  var activityEl = document.getElementById('activity-list');
  var holdEl = document.getElementById('hold');
  var heldEl = document.getElementById('held-banner');
  var lockedEl = document.getElementById('locked-banner');
  var held = false;

  // A locked phone is the one state where a black mirror is the truth rather
  // than a fault: the screen is off, so there is nothing to stream. Saying so
  // is the difference between "unlock your phone" and "the console is broken".
  function setLocked(on) {
    lockedEl.className = on ? 'on' : '';
  }

  function ask() {
    viewer.send({ type: 'console:approvals:list' });
  }

  function renderApprovals(items) {
    if (!items || !items.length) {
      approvalsEl.innerHTML = '<div class="empty">none</div>';
      return;
    }
    approvalsEl.innerHTML = items.map(renderApprovalRow).join('');
  }

  function renderActivity(items) {
    if (!items || !items.length) {
      activityEl.innerHTML = '<div class="empty">none</div>';
      return;
    }
    activityEl.innerHTML = items.slice(-20).reverse().map(renderActivityRow).join('');
  }

  function setHeld(on) {
    held = !!on;
    heldEl.className = held ? 'on' : '';
    holdEl.textContent = held ? 'Resume' : 'Hold';
    holdEl.className = held ? 'on' : '';
  }

  approvalsEl.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.hasAttribute) return;
    var allow = target.hasAttribute('data-allow');
    var deny = target.hasAttribute('data-deny');
    if (!allow && !deny) return;
    var row = target.closest('[data-id]');
    if (!row) return;
    var select = row.querySelector('[data-scope]');
    viewer.send({
      type: 'console:approvals:decide',
      id: row.getAttribute('data-id'),
      decision: allow ? 'allow' : 'deny',
      scope: select ? select.value : 'once'
    });
  });

  holdEl.addEventListener('click', function () {
    viewer.send({ type: held ? 'console:resume' : 'console:hold' });
  });

  viewer.on('console:approvals', function (msg) { renderApprovals(msg.items); });
  viewer.on('console:activity', function (msg) { renderActivity(msg.items); });
  viewer.on('console:held', function (msg) { setHeld(msg.held); });
  viewer.on('hello', function (msg) { setLocked(!!msg.locked); });
  viewer.on('nodes', function (msg) { setLocked(!!msg.locked); });
  viewer.on('console:error', function (msg) {
    var text = String(msg.message || 'console error');
    approvalsEl.insertAdjacentHTML('afterbegin', '<div class="empty">' + escapeHtml(text) + '</div>');
  });

  // Poll while idle: an agent in another process can be gated at any moment,
  // and the person watching this page should see the request without touching
  // anything. Two seconds is fast enough to answer inside the 60 s window.
  setInterval(function () {
    ask();
    viewer.send({ type: 'console:activity' });
    // The lease is shared with the CLI and with other tabs, so it is re-read
    // on the same tick: a hold taken or released elsewhere must show up here.
    viewer.send({ type: 'console:held:list' });
  }, 2000);
  ask();
  viewer.send({ type: 'console:activity' });
  viewer.send({ type: 'console:held:list' });
})();
`;
