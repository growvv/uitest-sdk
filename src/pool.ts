/**
 * A cache of open devices, keyed by hdc target id.
 *
 * Two callers asking for the same device share one connection — the agent
 * extension holds a global lock, so a second connection buys nothing and
 * doubles the ports. A failed connection is not cached: the next call retries.
 *
 * Leases are deliberately *not* taken here. A pool hands out a device; a
 * `Session` decides who may drive it.
 */
export class DevicePool<T> {
  private readonly devices = new Map<string, T>();
  private readonly connecting = new Map<string, Promise<T>>();

  constructor(private readonly connect: (id: string | undefined) => Promise<T>) {}

  /** Returns the device for `id`, connecting on first use. */
  async get(id?: string): Promise<T> {
    const key = id ?? "";
    const existing = this.devices.get(key);
    if (existing) return existing;
    const inFlight = this.connecting.get(key);
    if (inFlight) return inFlight;

    const promise = this.connect(id)
      .then((device) => {
        this.devices.set(key, device);
        return device;
      })
      .finally(() => {
        this.connecting.delete(key);
      });
    this.connecting.set(key, promise);
    return promise;
  }

  /** Forgets a device and disposes it, e.g. after a failed operation. */
  async drop(id?: string): Promise<void> {
    const key = id ?? "";
    const device = this.devices.get(key);
    this.devices.delete(key);
    if (device) await (device as { dispose?: () => Promise<void> }).dispose?.();
  }

  get size(): number {
    return this.devices.size;
  }

  ids(): string[] {
    return [...this.devices.keys()];
  }

  /** Disposes every open device. */
  async close(): Promise<void> {
    const all = [...this.devices.values()];
    this.devices.clear();
    await Promise.all(
      all.map((device) => (device as { dispose?: () => Promise<void> }).dispose?.()),
    );
  }
}
