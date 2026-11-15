import { describe, it, expect } from "vitest";
import { On } from "../../src/agent/selector.js";
import { Components, ComponentHandle } from "../../src/agent/components.js";
import { ElementNotFoundError } from "../../src/errors.js";

interface Call {
  api: string;
  args: unknown[];
  thisRef: string;
}

/** A fake device that answers hypium calls from a table. */
function fakeDevice(handlers: Record<string, (args: unknown[], thisRef: string) => unknown>) {
  const calls: Call[] = [];
  const seeded = new Map<string, string>();
  return {
    calls,
    async hypium(api: string, thisRef: string, args: unknown[]) {
      calls.push({ api, args, thisRef });
      // Selector construction is a device call too: On.* returns a reference.
      if (api.startsWith("On.")) {
        if (thisRef === "On#seed") {
          const ref = `On#${seeded.size}`;
          seeded.set(ref, ref);
          return ref;
        }
        return thisRef;
      }
      const h = handlers[api];
      if (!h) throw new Error(`no handler for ${api}`);
      return h(args, thisRef);
    },
  };
}

describe("Components", () => {
  it("finds a component with a device-side selector", async () => {
    const dev = fakeDevice({
      "Driver.findComponent": () => "Component#0",
    });
    const components = new Components(dev);
    const handle = await components.find(On.text("WLAN"));
    expect(dev.calls.at(-1)).toMatchObject({
      api: "Driver.findComponent",
      thisRef: "Driver#0",
    });
    expect(handle!.ref).toBe("Component#0");
  });

  it("returns null when nothing matches", async () => {
    const dev = fakeDevice({ "Driver.findComponent": () => null });
    expect(await new Components(dev).find(On.text("nope"))).toBeNull();
  });

  it("requires a non-null result, or throws not_found", async () => {
    const dev = fakeDevice({ "Driver.findComponent": () => null });
    const err = await new Components(dev).require(On.text("nope")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ElementNotFoundError);
    expect((err as Error).message).toContain('text="nope"');
  });

  it("waits for a component through the device, not a host loop", async () => {
    const dev = fakeDevice({ "Driver.waitForComponent": () => "Component#3" });
    const handle = await new Components(dev).waitFor(On.text("WLAN"), { timeoutMs: 2000 });
    const wait = dev.calls.find((c) => c.api === "Driver.waitForComponent")!;
    expect(wait.args).toEqual([expect.anything(), 2000]);
    expect(wait.thisRef).toBe("Driver#0");
    expect(handle?.ref).toBe("Component#3");
  });

  it("returns null when the wait times out", async () => {
    const dev = fakeDevice({ "Driver.waitForComponent": () => null });
    expect(await new Components(dev).waitFor(On.text("x"), { timeoutMs: 100 })).toBeNull();
  });

  it("lists every match", async () => {
    const dev = fakeDevice({ "Driver.findComponents": () => ["Component#0", "Component#1"] });
    const list = await new Components(dev).findAll(On.type("Button"));
    expect(list.map((h) => h.ref)).toEqual(["Component#0", "Component#1"]);
  });

  it("builds the On predicate with the right this-reference", async () => {
    const dev = fakeDevice({
      "On.text": (_a, thisRef) => (thisRef === "On#seed" ? "On#0" : thisRef),
      "Driver.findComponent": () => "Component#0",
    });
    await new Components(dev).find(On.text("WLAN"));
    expect(dev.calls.map((c) => c.api)).toEqual(["On.text", "Driver.findComponent"]);
    expect(dev.calls[1]!.args[0]).toBe("On#0");
  });

  it("caches nothing: each call asks the device", async () => {
    let n = 0;
    const dev = fakeDevice({ "Driver.findComponent": () => `Component#${n++}` });
    const components = new Components(dev);
    await components.find(On.text("a"));
    await components.find(On.text("a"));
    expect(dev.calls.filter((c) => c.api === "Driver.findComponent")).toHaveLength(2);
  });
});

describe("ComponentHandle", () => {
  it("reads bounds as a rect in display coordinates", async () => {
    const dev = fakeDevice({
      "Component.getBounds": () => ({ left: 10, top: 20, right: 110, bottom: 220, displayId: 0 }),
    });
    const handle = new ComponentHandle(dev, "Component#0", On.text("x"));
    expect(await handle.bounds()).toEqual({ x: 10, y: 20, width: 100, height: 200 });
  });

  it("clicks through the component, not a coordinate", async () => {
    const dev = fakeDevice({ "Component.click": () => null });
    const handle = new ComponentHandle(dev, "Component#0", On.text("x"));
    await handle.click();
    expect(dev.calls[0]).toMatchObject({ api: "Component.click", thisRef: "Component#0" });
  });

  it("types into the component", async () => {
    const dev = fakeDevice({ "Component.inputText": () => null });
    const handle = new ComponentHandle(dev, "Component#0", On.text("x"));
    await handle.inputText("hello");
    expect(dev.calls[0]!.args).toEqual(["hello"]);
  });

  it("reports text and type", async () => {
    const dev = fakeDevice({
      "Component.getText": () => "WLAN",
      "Component.getType": () => "Button",
    });
    const handle = new ComponentHandle(dev, "Component#0", On.text("x"));
    expect(await handle.text()).toBe("WLAN");
    expect(await handle.type()).toBe("Button");
  });

  it("scrolls a container until the target appears", async () => {
    const dev = fakeDevice({
      "On.text": () => "On#0",
      "Component.scrollSearch": () => "Component#9",
    });
    const handle = new ComponentHandle(dev, "Component#0", On.type("List"));
    const found = await handle.scrollSearch(On.text("关于"));
    expect(found?.ref).toBe("Component#9");
    expect(dev.calls.at(-1)!.thisRef).toBe("Component#0");
  });
});
