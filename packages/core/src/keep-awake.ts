/**
 * Keeps the display awake for as long as a product needs it.
 *
 * The device's own sleep timeout is the only lever a shell has: `power-shell
 * timeout -o <ms>` overrides it, `-r` puts the original back. There is no
 * "hold the screen on" API in the extension, so a product that wants the
 * picture to keep coming asks the platform not to dim.
 *
 * A mirror that goes dark after thirty seconds is indistinguishable from a
 * broken one, which is why `--stay-awake` exists rather than being the
 * default: changing a person's device settings is a side effect, and the
 * caller should ask for it.
 */

/** The part of `HypiumDriver` this module needs. */
export interface SleepControl {
  setSleepTime(seconds: number): Promise<void>;
  restoreSleepTime(): Promise<void>;
}

export interface KeepAwakeHandle {
  /** Puts the device's own timeout back. Idempotent. */
  restore(): Promise<void>;
}

/**
 * Overrides the device's sleep timeout and hands back a restore.
 *
 * `restore()` is guarded because two close paths can both reach it — the
 * person closing the window and the process being asked to stop — and a second
 * `-r` would undo a timeout someone else set in the meantime.
 *
 * It is best effort by nature: a process that is killed outright never runs
 * the restore, so the device keeps the override. The product's README names
 * `hdc shell power-shell timeout -r` for that case.
 */
export async function keepAwake(sleep: SleepControl, seconds = 3600): Promise<KeepAwakeHandle> {
  await sleep.setSleepTime(seconds);
  let restored = false;
  return {
    async restore() {
      if (restored) return;
      restored = true;
      await sleep.restoreSleepTime();
    },
  };
}
