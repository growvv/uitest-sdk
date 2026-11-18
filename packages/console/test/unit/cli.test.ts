import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { consoleOptions, consoleOptionsFrom, startConsole, waitForStop } from "../../src/cli.js";
import type { ConsoleCliOptions } from "../../src/cli.js";
import type { Screen } from "uitest-sdk";

describe("consoleOptions", () => {
  it("defaults to a masked local page on 7042", () => {
    const opts = consoleOptions({});
    expect(opts.port).toBe(7042);
    expect(opts.host).toBe("127.0.0.1");
    expect(opts.privacy).toBe(true);
    expect(opts.open).toBe(true);
    expect(opts.stateDir).toBe(".uitest-phone");
    expect(opts.task).toBe("console");
  });

  it("turns privacy off from any of the words people type", () => {
    for (const word of ["off", "false", "no", "0", "OFF"]) {
      expect(consoleOptions({ privacy: word }).privacy).toBe(false);
    }
    for (const word of ["on", "true", "yes", "1"]) {
      expect(consoleOptions({ privacy: word }).privacy).toBe(true);
    }
  });

  it("rejects a privacy value it cannot honour", () => {
    // Silently treating "maybe" as "on" would hide a person's intent; the page
    // must not guess whether it is allowed to show a password.
    expect(() => consoleOptions({ privacy: "maybe" })).toThrow(/privacy/);
  });

  it("rejects a transport it does not have instead of picking one", () => {
    expect(() => consoleOptions({ transport: "tcp" })).toThrow(/transport/);
    expect(consoleOptions({ transport: "mjpeg" }).transport).toBe("mjpeg");
  });

  it("rejects a port it cannot bind", () => {
    expect(() => consoleOptions({ port: "70000" })).toThrow(/port/);
    expect(() => consoleOptions({ port: "eighty" })).toThrow(/port/);
  });

  it("carries the device, recording path and hand-started page through", () => {
    const opts = consoleOptions({
      device: "SERIAL",
      record: "demo.mp4",
      noOpen: true,
      task: "checkout",
    });
    expect(opts.device).toBe("SERIAL");
    expect(opts.record).toBe("demo.mp4");
    expect(opts.open).toBe(false);
    expect(opts.task).toBe("checkout");
  });

  // `--device`, `--state-dir` and `--task` are global flags: `parseArgv` files
  // them under `options`, not `args`. Reading only `args` made the console
  // silently ignore the device a person named and open whichever one it found
  // — which is how a two-device acceptance run ended up pointed at the wrong
  // phone and failing to find the agent daemon it expected.
  it("reads the device, state dir and task the parser puts in options", () => {
    const opts = consoleOptionsFrom(["--device", "SERIAL", "--state-dir", "/tmp/state", "--task", "checkout"]);
    expect(opts.device).toBe("SERIAL");
    expect(opts.stateDir).toBe("/tmp/state");
    expect(opts.task).toBe("checkout");
  });
});

const screen: Screen = {
  header: "",
  bundle: "com.demo",
  display: { width: 400, height: 800 },
  rotation: 0,
  elements: [],
  lines: [],
  hash: "h",
  signatures: new Set(),
  tree: { attributes: {}, children: [] },
  at: 0,
};

function options(over: Partial<ConsoleCliOptions> = {}): ConsoleCliOptions {
  return {
    port: 0,
    host: "127.0.0.1",
    privacy: true,
    open: false,
    stateDir: mkdtempSync(join(tmpdir(), "console-cli-")),
    task: "console",
    layout: true,
    scale: 1,
    frameRate: 30,
    ...over,
  };
}

describe("waitForStop", () => {
  // A supervisor on Windows cannot deliver SIGTERM: `child.kill()` terminates
  // the process outright, so the handler that releases the device never runs
  // and the console's port forward outlives it. Twenty such forwards filled
  // 8012..8031 and the next run could not open the tunnel at all. Closing the
  // child's stdin is the signal a supervisor *can* send on every platform.
  it("stops when the supervisor closes stdin", async () => {
    const stdin = new EventEmitter() as EventEmitter & { resume(): void };
    stdin.resume = () => undefined;
    const signals = new EventEmitter();

    const stopped = waitForStop({ stdin, signals });
    stdin.emit("end");
    await expect(stopped).resolves.toBeUndefined();
  });

  it("still stops on SIGINT from a terminal", async () => {
    const stdin = new EventEmitter() as EventEmitter & { resume(): void };
    stdin.resume = () => undefined;
    const signals = new EventEmitter();

    const stopped = waitForStop({ stdin, signals });
    signals.emit("SIGINT");
    await expect(stopped).resolves.toBeUndefined();
  });

  it("resolves once, whichever comes first", async () => {
    const stdin = new EventEmitter() as EventEmitter & { resume(): void };
    stdin.resume = () => undefined;
    const signals = new EventEmitter();

    let stops = 0;
    const stopped = waitForStop({ stdin, signals }).then(() => {
      stops++;
    });
    signals.emit("SIGTERM");
    stdin.emit("end");
    await stopped;
    expect(stops).toBe(1);
  });
});

describe("startConsole", () => {
  it("opens the session without a lease, so an agent keeps working", async () => {
    // Watching must not pause an agent: the whole point of a person-side page
    // is to look while a task runs. `Hold` is the explicit pause.
    const calls: string[] = [];
    const session = {
      core: {
        reader: { builder: { setRedact: () => undefined }, read: async () => screen },
        observe: async () => ({ status: "settled" }),
      },
      device: { agent: { getDisplaySize: async () => ({ width: 400, height: 800 }) } },
      tag: "7544d645",
      close: async () => {
        calls.push("close");
      },
    };

    const run = await startConsole(options(), async (opts) => {
      calls.push(`lease:${String(opts.lease)}`);
      return session as never;
    });
    try {
      expect(calls[0]).toBe("lease:false");
      expect(run.tag).toBe("7544d645");
      expect(run.url).toBe(`http://127.0.0.1:${run.port}/`);
    } finally {
      await run.close();
    }
    expect(calls).toContain("close");
  });

  it("closes the page before it lets go of the device", async () => {
    const calls: string[] = [];
    const session = {
      core: {
        reader: { builder: { setRedact: () => undefined }, read: async () => screen },
        observe: async () => ({ status: "settled" }),
      },
      device: { agent: { getDisplaySize: async () => ({ width: 400, height: 800 }) } },
      tag: "6c585f5b",
      close: async () => {
        calls.push("close");
      },
    };
    const run = await startConsole(options(), async () => session as never);
    await run.close();
    expect(calls).toEqual(["close"]);
    // A second close is a no-op rather than a second release.
    await run.close();
    expect(calls).toEqual(["close"]);
  });
});

describe("consoleOptions: stream settings", () => {
  it("carries the scale, frame rate and ws settings through", () => {
    // These came from the old `live` command and still matter: a slow link
    // needs --scale 2, and a 7.0 device needs --transport ws plus its .so.
    const opts = consoleOptions({ scale: "2", fps: "60", castPort: "5001", wsExtension: "x.z.so" });
    expect(opts.scale).toBe(2);
    expect(opts.frameRate).toBe(60);
    expect(opts.castPort).toBe(5001);
    expect(opts.wsExtension).toBe("x.z.so");
  });

  it("rejects scale and frame rates the extension cannot encode", () => {
    expect(() => consoleOptions({ scale: "6" })).toThrow(/scale/);
    expect(() => consoleOptions({ scale: "0" })).toThrow(/scale/);
    expect(() => consoleOptions({ fps: "24" })).toThrow(/fps/);
  });

  it("allows a video-only page", () => {
    expect(consoleOptions({ noLayout: true }).layout).toBe(false);
  });
});

describe("startConsole: address and layout", () => {
  const session = () => ({
    core: {
      reader: { builder: { setRedact: () => undefined }, read: async () => screen },
      observe: async () => ({ status: "settled" }),
    },
    device: { agent: { getDisplaySize: async () => ({ width: 400, height: 800 }) } },
    tag: "7544d645",
    close: async () => undefined,
  });

  it("reports a loopback address for a wildcard bind", async () => {
    // `--host 0.0.0.0` means "reachable from elsewhere", but 0.0.0.0 is not a
    // URL a browser can open: the printed address has to be one it can dial.
    for (const host of ["0.0.0.0", "::"]) {
      const run = await startConsole(options({ host }), async () => session() as never);
      try {
        expect(run.url).toBe(`http://127.0.0.1:${run.port}/`);
      } finally {
        await run.close();
      }
    }
  });

  it("serves a video-only page when the layout is off", async () => {
    const run = await startConsole(options({ layout: false }), async () => session() as never);
    try {
      const html = await (await fetch(run.url)).text();
      expect(html).toContain('id="inbox"');
    } finally {
      await run.close();
    }
  });
});

describe("startConsole: failure paths", () => {
  function session(onClose: () => void) {
    return {
      core: {
        reader: { builder: { setRedact: () => undefined }, read: async () => screen },
        observe: async () => ({ status: "settled" }),
      },
      device: { agent: { getDisplaySize: async () => ({ width: 400, height: 800 }) } },
      tag: "7544d645",
      close: async () => onClose(),
    };
  }

  it("lets the device go when the page cannot start", async () => {
    // A port already in use is the everyday case: the person ran the console
    // twice. Leaving the session open would keep a daemon and an fport behind
    // for a page that never existed.
    const calls: string[] = [];
    const first = await startConsole(options(), async () => session(() => calls.push("close")) as never);
    try {
      await expect(
        startConsole(options({ port: first.port }), async () => session(() => calls.push("close")) as never),
      ).rejects.toThrow();
      expect(calls).toEqual(["close"]);
    } finally {
      await first.close();
    }
  });

  it("lets the device go when the session itself fails", async () => {
    await expect(
      startConsole(options(), async () => {
        throw new Error("another task holds the lease");
      }),
    ).rejects.toThrow("another task holds the lease");
  });
});
