/**
 * Screenshots of a page in a real browser, for the acceptance reports.
 *
 * The device screenshots come from the SDK itself; the viewer's screenshots
 * have to come from a browser, or the report would be describing a page nobody
 * looked at. This starts a headless Chrome, drives it over the DevTools
 * protocol, and kills only the browser it started.
 *
 * Usage as a library:
 *   import { capturePage } from "./screenshot.mjs";
 *   await capturePage({ url, out: "shot.jpg" });
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromeKillSteps } from "./live-walk.js";

const DEFAULT_WAIT = 'window.uitestViewer && document.querySelector("canvas")';

/** Where Chrome usually is, per platform. */
export function chromeCandidates(platform = process.platform, env = process.env) {
  const list = [];
  if (env.CHROME_PATH) list.push(env.CHROME_PATH);
  if (platform === "win32") {
    list.push(
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    );
  } else if (platform === "darwin") {
    list.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else {
    list.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }
  return list;
}

export function findChrome(platform = process.platform, env = process.env) {
  return chromeCandidates(platform, env).find((p) => existsSync(p)) ?? null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Saves one page to `out`.
 *
 * `waitFor` is a JS expression polled until it is truthy — the viewer sets
 * `window.uitestViewer` once a frame has decoded, and a screenshot taken before
 * that is a picture of an empty canvas. The default waits for exactly that.
 * The file extension decides the format: `.jpg` is written as JPEG so the site
 * check's "complete JPEG" rule holds for browser shots too.
 *
 * `prepare` runs after the page is ready and before the shot, with an
 * `evaluate` bound to the page: that is how a case turns a switch, types into
 * the page's own field, or waits for a second condition that only exists once
 * the first is true. It may return an array of strings, which come back as the
 * result — the evidence that the interaction actually happened.
 */
export async function capturePage({
  url,
  out,
  width = 1440,
  height = 900,
  waitFor = DEFAULT_WAIT,
  timeoutMs = 20_000,
  chromePath = findChrome(),
  prepare,
}) {
  if (!chromePath) throw new Error("no Chrome or Edge found; set CHROME_PATH");
  const target = resolve(out);
  const port = 9500 + Math.floor(Math.random() * 400);
  // One profile per capture. A shared `--user-data-dir` makes the second
  // launch join the first browser instead of starting its own: its DevTools
  // port answers with the *other* page, and the kill at the end takes down a
  // browser this call did not start. That surfaced as intermittent
  // "page never satisfied" failures on a run that had just worked.
  const profile = join(process.cwd(), ".work-bench", `chrome-shot-${process.pid}-${port}`);
  const child = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: "ignore", detached: process.platform !== "win32" },
  );

  const kill = () => {
    const pid = child.pid;
    if (pid === undefined) return;
    for (const step of chromeKillSteps(pid)) {
      try {
        if (step.kind === "exec") execFileSync(step.command, step.args, { stdio: "ignore" });
        else process.kill(step.pid, step.signal);
      } catch {
        // Already gone.
      }
    }
  };

  let socket;
  try {
    let ws = "";
    for (let i = 0; i < 150 && !ws; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        ws = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
      } catch {
        // Still starting.
      }
      if (!ws) await sleep(100);
    }
    if (!ws) throw new Error("Chrome's debugging port never opened");

    socket = new WebSocket(ws);
    await new Promise((res, rej) => {
      socket.onopen = () => res();
      socket.onerror = () => rej(new Error("CDP socket failed"));
    });

    let nextId = 1;
    const pending = new Map();
    socket.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, res);
        socket.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rej(new Error(`${method} timed out`));
          }
        }, timeoutMs);
      });

    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result?.result?.value;
    };

    await send("Page.enable");
    await send("Page.navigate", { url });
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(waitFor)) {
          ready = true;
          break;
        }
      } catch {
        // Page not loaded yet.
      }
      await sleep(150);
    }
    if (!ready) throw new Error(`page never satisfied: ${waitFor}`);

    // One more frame so the canvas is painted after the predicate goes true.
    await sleep(400);
    const notes = prepare ? await prepare(evaluate) : [];
    const shot = await send("Page.captureScreenshot", {
      format: target.toLowerCase().endsWith(".png") ? "png" : "jpeg",
      quality: target.toLowerCase().endsWith(".png") ? undefined : 88,
    });
    const data = shot.result?.data;
    if (!data) throw new Error("captureScreenshot returned nothing");
    await writeFile(target, Buffer.from(data, "base64"));
    return { path: target, notes: notes ?? [] };
  } finally {
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
    kill();
    // The profile is scratch for this one capture; leaving it behind fills
    // .work-bench with a copy of a browser's state per screenshot.
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}
