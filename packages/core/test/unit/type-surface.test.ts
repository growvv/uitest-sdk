import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const CORE = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * The documented API must be importable from the package people install.
 *
 * `observe.window()` returns `WindowResult` and `act.drag` takes `Point`; a
 * TypeScript consumer who cannot name those types has to reach into
 * `uitest-sdk/dist/...`, which the architecture forbids. The check compiles a
 * fixture against the built declarations, so an unexported type fails here
 * rather than in a user's editor.
 */
describe("public type surface", () => {
  it("exports every type the documented signatures use", () => {
    const dir = mkdtempSync(join(tmpdir(), "uitest-types-"));
    // A consumer installs the package into node_modules; the fixture gets the
    // same view by linking the workspace copy, so resolution is the real one
    // rather than a paths alias that could hide a broken `exports` map.
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync(CORE, join(dir, "node_modules", "uitest-sdk"), "junction");
    writeFileSync(
      join(dir, "fixture.ts"),
      `import { connect } from "uitest-sdk";
import type {
  WindowResult, WindowOptions, WindowFilter, InspectResult, WaitForOptions,
  SwipeInput, ListOptions, PinchInput, DragOptions, FlingOptions,
  RecordingHandle, ApprovalScope, ApprovalDecision, Point, Rect,
  SessionOptions, TapOptions, Target, TypeOptions,
} from "uitest-sdk";
import type { H264Chunk } from "uitest-sdk/cast";
import { On } from "uitest-sdk/drivers";
import type { SessionAgent, SessionDevice } from "uitest-sdk/drivers";

export async function use(): Promise<void> {
  const s = await connect();
  const w: WindowResult = await s.observe.window({} as WindowFilter, {} as WindowOptions);
  const i: InspectResult = await s.observe.inspect();
  const d: DragOptions = { holdMs: 1, approvalScope: "once" as ApprovalScope };
  const f: FlingOptions = {};
  const p: Point = { x: 1, y: 2 };
  const r: Rect = { x: 0, y: 0, width: 1, height: 1 };
  const sw: SwipeInput = { from: p, to: p };
  const pi: PinchInput = { center: p, from: 1, to: 2 };
  const wf: WaitForOptions = {};
  const lo: ListOptions = {};
  const rh: RecordingHandle = { path: "x", stop: async () => null };
  const ad: ApprovalDecision = "allow";
  const so: SessionOptions = {};
  const to: TapOptions = {};
  const ta: Target = { text: "7" };
  const ty: TypeOptions = { paste: true };
  const on: On = On.text("x");
  const chunk: H264Chunk = { data: Buffer.alloc(0), pts: 0, flags: 0, isKeyFrame: false };
  void [w, i, d, f, p, r, sw, pi, wf, lo, rh, ad, so, to, ta, ty, on, chunk];
}
export type _Agent = SessionAgent;
export type _Device = SessionDevice;
`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        files: ["fixture.ts"],
      }),
    );

    // TypeScript is hoisted to the workspace root; resolving it from the
    // package would look for a copy npm never puts there.
    const tsc = join(CORE, "..", "..", "node_modules", "typescript", "bin", "tsc");
    let output = "";
    let code = 0;
    try {
      execFileSync(process.execPath, [tsc, "-p", dir], { cwd: dir, encoding: "utf8" });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      code = err.status ?? 1;
    }
    expect(output, "tsc errors").not.toMatch(/TS2305|TS2724|TS2307/);
    expect(output, `tsc exited ${code}`).toBe("");
    expect(code).toBe(0);
  });

  // Documentation is read by people who then type what it says. Every import
  // line in the shipped README, the API reference and the site's samples must
  // resolve against the built package, or the sample teaches an import that
  // fails in the reader's editor.
  it("every documented import resolves against the package", () => {
    const sources = [
      "packages/core/README.md",
      "packages/core/docs/api.md",
      "packages/core/examples/quickstart.mjs",
    ].map((rel) => ({ rel, text: readFileSync(new URL(`../../../../${rel}`, import.meta.url), "utf8") }));

    // One file per import: two samples that both import `connect` would
    // otherwise collide as duplicate identifiers, which says nothing about
    // whether either sample's module path exists.
    const dir = mkdtempSync(join(tmpdir(), "uitest-docimports-"));
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync(CORE, join(dir, "node_modules", "uitest-sdk"), "junction");

    const files: string[] = [];
    for (const { rel, text } of sources) {
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*import\s+(?:type\s+)?(.+?)\s+from\s+"(uitest-sdk(?:\/[a-z]+)?)"/);
        if (!m) continue;
        const name = `doc${files.length}.ts`;
        writeFileSync(join(dir, name), `import ${m[1]} from "${m[2]}"; // ${rel}\nexport {};\n`);
        files.push(name);
      }
    }
    expect(files.length).toBeGreaterThan(5);

    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        files,
      }),
    );

    const tsc = join(CORE, "..", "..", "node_modules", "typescript", "bin", "tsc");
    let output = "";
    try {
      execFileSync(process.execPath, [tsc, "-p", dir], { cwd: dir, encoding: "utf8" });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    expect(output).toBe("");
  });
});
