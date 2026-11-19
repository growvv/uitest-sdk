import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../../src/operations/session.js";
import type { UiNode } from "../../src/transport/model.js";

const node = (type: string, attrs: Record<string, unknown>, children: UiNode[] = []): UiNode => ({
  attributes: { type, ...attrs } as UiNode["attributes"],
  children,
});

/**
 * The screen, with the field's value owned here so `inputText` can change it:
 * a fake that accepted text without the field reflecting it would now (rightly)
 * be reported as a failed type.
 */
const tree = (value: { text: string }): UiNode =>
  node("Root", { bounds: "[0,0][1000,2000]", bundleName: "com.demo" }, [
    node("TextInput", { text: value.text, bounds: "[100,700][900,800]", focused: "true" }),
  ]);

interface TextCall {
  x: number;
  y: number;
  text: string;
  mode: unknown;
}

/** A device whose only interesting surface is inputText. */
function fakeDevice() {
  const texts: TextCall[] = [];
  const value = { text: "query" };
  return {
    texts,
    device: {
      deviceId: "SERIAL0123456789",
      agent: {
        async hypium() {
          return null;
        },
        async captureLayout() {
          return tree(value);
        },
        async getDisplaySize() {
          return { width: 1000, height: 2000 };
        },
        async getDisplayRotation() {
          return 0;
        },
        async captureScreen() {
          return Buffer.alloc(0);
        },
        async click() {},
        async touchDown() {},
        async touchMove() {},
        async touchUp() {},
        // The optional mode is the whole point: it must reach the device.
        async inputText(x: number, y: number, text: string, mode?: unknown) {
          texts.push({ x, y, text, mode });
          value.text = text;
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

async function withSession<T>(fn: (s: Session, fake: ReturnType<typeof fakeDevice>) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "uitest-type-"));
  const fake = fakeDevice();
  const s = await Session.open(fake.device, {
    task: "test",
    stateDir: dir,
    lease: { dir },
    traceShots: false,
    policy: { readOnly: false },
  });
  try {
    return await fn(s, fake);
  } finally {
    await s.release();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Session.type: input mode", () => {
  it("sends no mode when none was asked for", async () => {
    await withSession(async (s, fake) => {
      const r = await s.type("hello");
      expect(r.status).toBe("settled");
      expect(fake.texts).toEqual([{ x: 500, y: 750, text: "hello", mode: undefined }]);
    });
  });

  it("passes paste through to the device", async () => {
    await withSession(async (s, fake) => {
      const r = await s.type("a long sentence", { paste: true });
      expect(r.status).toBe("settled");
      expect(fake.texts[0]!.mode).toEqual({ paste: true });
    });
  });
});
