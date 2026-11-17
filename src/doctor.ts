import { tagOf } from "./session.js";
import type { Session, SessionDevice } from "./session.js";

export interface Capabilities {
  waitForIdle: boolean;
  findComponent: boolean;
  waitForComponent: boolean;
  findWindow: boolean;
  multiTouch: boolean;
}

export interface DoctorReport {
  targets: string[];
  display: { width: number; height: number } | null;
  capabilities: Capabilities;
  session: {
    task: string;
    deviceTag: string;
    readOnly: boolean;
    confirm: string[];
    apps: string[];
    allowCredentials: boolean;
  } | null;
  problems: string[];
}

/** A device that can list attached targets; HdcRunner satisfies this. */
export interface TargetLister {
  listTargets(): Promise<string[]>;
}

type Probe = (device: SessionDevice) => Promise<unknown>;

/**
 * One probe per capability. `On.text` is included because a selector chain is
 * useless if the seed object cannot be created on this extension version.
 */
const PROBES: Record<keyof Capabilities, Probe> = {
  waitForIdle: (d) => d.agent.hypium("Driver.waitForIdle", "Driver#0", [50, 500]),
  findComponent: async (d) => {
    const on = await d.agent.hypium("On.text", "On#seed", ["__uitest_doctor__", 0]);
    return d.agent.hypium("Driver.findComponents", "Driver#0", [on]);
  },
  waitForComponent: async (d) => {
    const on = await d.agent.hypium("On.text", "On#seed", ["__uitest_doctor__", 0]);
    return d.agent.hypium("Driver.waitForComponent", "Driver#0", [on, 1]);
  },
  findWindow: (d) => d.agent.hypium("Driver.findWindow", "Driver#0", [{ focused: true }]),
  multiTouch: (d) => d.agent.hypium("PointerMatrix.create", "PointerMatrix#seed", [2, 2]),
};

/**
 * Checks that the device answers the calls this SDK depends on.
 *
 * A missing capability is reported, not thrown: the rest of the SDK still
 * works, and the caller decides what to do without it. `waitForComponent` is
 * probed with a 1 ms timeout so a device that does have it returns at once.
 */
export async function doctor(
  device: SessionDevice,
  session?: Session,
  /** The target the caller chose; when set, the warning below is moot. */
  chosen?: string,
): Promise<DoctorReport> {
  const problems: string[] = [];
  const attached = await listTargets(device);
  // Once a target is chosen, that is the device being checked, and the fact
  // that others are attached is not something to warn about: the advice
  // ("pass a device id") has already been taken.
  const targets = chosen ? [chosen] : attached;

  let display: { width: number; height: number } | null = null;
  try {
    display = await device.agent.getDisplaySize();
  } catch (e) {
    problems.push(`display: ${message(e)}`);
  }

  const capabilities = {} as Capabilities;
  for (const name of Object.keys(PROBES) as (keyof Capabilities)[]) {
    capabilities[name] = await supports(() => PROBES[name](device), name, problems);
  }

  if (targets.length > 1) {
    problems.push(
      `multiple targets attached (${targets.map(tag).join(", ")}): pass a device id so the SDK does not pick one for you`,
    );
  }
  const info = session
    ? { task: session.task, deviceTag: session.tag, ...session.policy.describe() }
    : null;

  return { targets, display, capabilities, session: info, problems };
}

async function supports(call: () => Promise<unknown>, name: string, problems: string[]): Promise<boolean> {
  try {
    await call();
    return true;
  } catch (e) {
    const detail = message(e);
    if (/no handler|not found|unsupported|not support/i.test(detail)) {
      problems.push(`${name}: not available on this extension (${detail})`);
    } else {
      problems.push(`${name}: ${detail}`);
    }
    return false;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function listTargets(device: SessionDevice): Promise<string[]> {
  const lister = device.hdc as TargetLister | undefined;
  if (!lister || typeof lister.listTargets !== "function") return [];
  return lister.listTargets().catch(() => []);
}

/**
 * A stable short id for a device, so serials never appear in output.
 *
 * This is `tagOf` from the session, not a second hash. The person who reads
 * `targets:` here has to find the same device again in `status`, in a lease
 * name and in a trace file, and all three use that one. A separate hash made
 * the same phone print as `dev-bff94761` in one place and `7544d645` in
 * another — the `dev-` prefix was the only thing that differed, which made the
 * mismatch look intentional.
 */
export function deviceTagOf(target: string): string {
  return tagOf(target);
}

const tag = deviceTagOf;

/** The same report as text, one line per fact — what a CLI prints. */
export function renderDoctor(report: DoctorReport): string {
  const lines = ["settled · doctor"];
  lines.push(`targets: ${report.targets.length ? report.targets.map(tag).join(", ") : "none"}`);
  lines.push(`display: ${report.display ? `${report.display.width}x${report.display.height}` : "unknown"}`);
  const caps = Object.entries(report.capabilities)
    .map(([name, ok]) => `${name}=${ok ? "yes" : "no"}`)
    .join(" ");
  lines.push(`capabilities: ${caps}`);
  if (report.session) {
    const s = report.session;
    lines.push(
      `session: task "${s.task}" · device ${s.deviceTag}` +
        ` · read-only ${s.readOnly}` +
        ` · confirm ${s.confirm.join(",") || "none"}` +
        ` · apps ${s.apps.join(",") || "all"}`,
    );
  } else {
    lines.push("session: none");
  }
  if (report.problems.length) {
    lines.push("problems:");
    for (const problem of report.problems) lines.push(`  - ${problem}`);
  }
  return lines.join("\n");
}
