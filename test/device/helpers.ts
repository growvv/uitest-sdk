import { Device } from "../../src/device.js";

export function getTarget(): string | undefined {
  const i = process.argv.indexOf("--target");
  if (i >= 0) return process.argv[i + 1];
  return process.env.UITEST_TARGET; // undefined → first target from `hdc list targets`
}

/** x86_64 emulators have no casting extension build, so those cases must skip. */
export function hasCastSupport(): boolean {
  const t = getTarget() ?? "";
  return !t.startsWith("127.0.0.1:"); // emulator targets are always treated as no-casting
}

/** Inverse of `hasCastSupport`, matching the name in the plan's Interfaces block. */
export function skipIfNoCast(): boolean {
  return !hasCastSupport();
}

/**
 * Kills every uitest process on the target. Only for test setup: it is exactly
 * the blind kill the SDK must never do on its own.
 */
export async function killAllUitest(): Promise<void> {
  const { HdcRunner } = await import("../../src/hdc.js");
  const hdc = new HdcRunner({ deviceId: getTarget() });
  const out = await hdc.shell("pidof uitest").catch(() => "");
  const pids = out.split(/\s+/).filter((t) => /^\d+$/.test(t));
  if (pids.length > 0) {
    await hdc.shell(`kill -9 ${pids.join(" ")}`).catch(() => undefined);
  }
}

export async function getDevice(): Promise<Device> {
  const dev = await Device.connect({ deviceId: getTarget() });
  // Screen capture is muted when the display sleeps (`Screen turned off! mute
  // screenCopy`), which silently starves every streaming case. Keep it awake.
  await keepScreenAwake(dev);
  return dev;
}

/**
 * Wakes the display and pushes the screen-off timeout out of the way for the
 * duration of the run. Best effort: a device that refuses the commands still
 * runs the non-streaming cases.
 */
export async function keepScreenAwake(dev: Device): Promise<void> {
  const hdc = (dev as unknown as { hdc: { shell(cmd: string): Promise<string> } }).hdc;
  await hdc.shell("power-shell wakeup").catch(() => undefined);
  await hdc.shell("power-shell timeout -o 3600000").catch(() => undefined);
}

/** Counts nodes in a layout tree, for sanity-checking a dump. */
export function countNodes(n: { children?: unknown[] }): number {
  const kids = (n.children ?? []) as Array<{ children?: unknown[] }>;
  return 1 + kids.reduce((acc, c) => acc + countNodes(c), 0);
}

/**
 * Keeps the screen moving so dirty-region capture produces frames, and returns
 * a stop function. A static screen yields one frame and then nothing.
 */
export function startMotion(dev: Device, s: { width: number; height: number }): () => void {
  let alive = true;
  void (async () => {
    let n = 0;
    while (alive) {
      n++;
      const y1 = Math.floor(s.height * (n % 2 ? 0.7 : 0.3));
      const y2 = Math.floor(s.height * (n % 2 ? 0.3 : 0.7));
      try {
        await dev.agent.swipe(s.width / 2, y1, s.width / 2, y2, { durationMs: 200 });
      } catch {
        /* busy or transient: the loop is only here to create motion */
      }
    }
  })();
  return () => {
    alive = false;
  };
}
