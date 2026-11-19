import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { Session } from "../../src/operations/session.js";
import type { UiNode } from "../../src/transport/model.js";

const node = (type: string, attrs: Record<string, unknown>, children: UiNode[] = []): UiNode => ({
  attributes: { type, ...attrs } as UiNode["attributes"],
  children,
});

const solidJpeg = () =>
  jpeg.encode({ data: Buffer.alloc(20 * 40 * 4, 0x11), width: 20, height: 40 }, 80).data;

/** One screen, holding one input whose value the device decides after a keystroke. */
function fakeDevice(opts: {
  /** The value the field holds when the screen is first read. */
  initial: string;
  /** The value the field holds after `inputText` runs. */
  after: string;
  /** Field attributes, to model a field whose value cannot be read back. */
  extra?: Record<string, unknown>;
  /** Leave `text` off the field entirely, the way an empty input can render. */
  omitText?: boolean;
  /** Give the field a resource id, the way a real app does. */
  id?: string;
  /** Move and resize the field once text arrives, the way the dialer does. */
  resizes?: boolean;
}) {
  let value = opts.initial;
  const actions: { kind: string; args: unknown[] }[] = [];
  const tree = (): UiNode =>
    node("Root", { bounds: "[0,0][1000,2000]", bundleName: "com.demo" }, [
      node("TextInput", {
        ...(opts.omitText ? {} : { text: value }),
        ...(opts.id ? { id: opts.id } : {}),
        bounds:
          opts.resizes && value
            ? "[50,700][950,800]"
            : "[100,700][900,800]",
        focused: "true",
        ...opts.extra,
      }),
    ]);
  return {
    actions,
    get value() {
      return value;
    },
    device: {
      deviceId: "SERIAL0123456789",
      agent: {
        async hypium(api: string) {
          if (api === "Driver.waitForIdle") return true;
          return null;
        },
        async captureLayout() {
          return tree();
        },
        async getDisplaySize() {
          return { width: 1000, height: 2000 };
        },
        async getDisplayRotation() {
          return 0;
        },
        async captureScreen() {
          return Buffer.from(solidJpeg());
        },
        async click() {},
        async touchDown() {},
        async touchMove() {},
        async touchUp() {},
        async inputText(_x: number, _y: number, _text: string, mode?: unknown) {
          actions.push({ kind: "inputText", args: [mode] });
          // `paste` is the path the device delivers intact; anything else is
          // the per-key path, whose result is whatever the app made of it.
          const pasted = Boolean((mode as { paste?: boolean } | undefined)?.paste);
          value = pasted ? opts.after : opts.after;
        },
        async triggerKey() {},
      },
      hdc: {
        async shell() {
          return "";
        },
      },
      async dispose() {},
    },
  };
}

async function withSession<T>(
  fake: ReturnType<typeof fakeDevice>,
  fn: (s: Session) => Promise<T>,
  opts = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "uitest-type-readback-"));
  const s = await Session.open(fake.device, {
    task: "test",
    stateDir: dir,
    lease: { dir },
    traceShots: false,
    policy: { readOnly: false },
    ...opts,
  });
  try {
    return await fn(s);
  } finally {
    await s.release();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Session.type: reads the field back", () => {
  it("reports settled when the field holds what was asked for", async () => {
    const fake = fakeDevice({ initial: "", after: "10086" });
    await withSession(fake, async (s) => {
      const r = await s.type("10086");
      expect(r.status).toBe("settled");
    });
  });

  it("does not report settled when the field holds something else", async () => {
    // The dialer turned "10086" into "1086" on the real device.
    const fake = fakeDevice({ initial: "", after: "1086" });
    await withSession(fake, async (s) => {
      const r = await s.type("10086");
      expect(r.status).toBe("uncertain");
      expect(r.status === "uncertain" && r.reason).toContain("10086");
    });
  });

  it("counts replaced text as landed, not as missing", async () => {
    // Typing into a field that already held something replaces it; the old
    // value must not be read as "the new text did not arrive".
    const fake = fakeDevice({ initial: "hello", after: "world" });
    await withSession(fake, async (s) => {
      const r = await s.type("world");
      expect(r.status).toBe("settled");
    });
  });

  it("does not fail a field whose value cannot be read back", async () => {
    // A field with no `text` at all tells us nothing; guessing a failure
    // would make every such app untypeable.
    const fake = fakeDevice({ initial: "", after: "", omitText: true });
    await withSession(fake, async (s) => {
      const r = await s.type("anything");
      expect(r.status).toBe("settled");
    });
  });

  it("finds the field again after it moves and resizes", async () => {
    // The dialer's field shifts left and triples in width as digits arrive, so
    // matching by position misses it. Its resource id is what survives.
    const fake = fakeDevice({ initial: "", after: "1086", id: "telNumberInput", resizes: true });
    await withSession(fake, async (s) => {
      const r = await s.type("10086");
      expect(r.status).toBe("uncertain");
    });
  });

  it("accepts a field that formats what it was given", async () => {
    // An amount field renders "1,000" for "1000"; the digits all arrived, so
    // this is a success, not a failed type.
    const fake = fakeDevice({ initial: "", after: "1,000" });
    await withSession(fake, async (s) => {
      expect((await s.type("1000")).status).toBe("settled");
    });
  });

  it("never puts a password into a failure message", async () => {
    // A password field is refused before any keystroke, so it can never reach
    // the read-back. If that gate is ever loosened, the read-back must still
    // not echo the value — this pins both halves.
    const fake = fakeDevice({
      initial: "",
      after: "hunter2x",
      extra: { textInputType: "Password" },
    });
    await withSession(fake, async (s) => {
      const r = await s.type("hunter2");
      expect(r.status).toBe("blocked");
      expect(JSON.stringify(r)).not.toContain("hunter2");
    });
  });
});
