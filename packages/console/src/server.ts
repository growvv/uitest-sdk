import type { ViewerClient, ViewerHooks, ViewerSource, ViewerServer } from "uitest-sdk/viewer";
import { renderPlayerPage, startViewerServer } from "uitest-sdk/viewer";
import type {
  ApprovalDecision,
  ApprovalScope,
  DecisionResult,
  PendingApproval,
  HoldResult,
  TraceRecord,
} from "uitest-sdk/govern";
import { CONSOLE_HTML, CONSOLE_SCRIPT } from "./page.js";

/** The person-side half of core's approval gateway. */
export interface ApprovalStore {
  pending(): PendingApproval[];
  decide(
    id: string,
    decision: ApprovalDecision,
    opts?: { by?: "cli" | "console"; scope?: ApprovalScope; reason?: string },
  ): DecisionResult;
}

/**
 * What the console asks core for, injected so the hooks can be tested without
 * a device: the approval store, the two lease writes, and the trace reader.
 */
export interface ConsoleDeps {
  approvals: ApprovalStore;
  stateDir: string;
  /** This console session's device tag, so a hold names the right device. */
  tag: string;
  hold(): Promise<HoldResult>;
  resume(): Promise<boolean>;
  /**
   * Whether a person holds the device right now.
   *
   * Read from the lease rather than remembered here: the hold may have been
   * written by `uitest-phone hold` before this console started, and it may be
   * released from another shell while the page is open.
   */
  isHeld(): Promise<boolean>;
  activity(): Promise<TraceRecord[]>;
}

export interface ConsoleOptions extends ConsoleDeps {
  source: ViewerSource;
  port?: number;
  host?: string;
  privacy?: boolean;
  /** What `--record <file>` asked for; omitted means a timestamped name. */
  recordPath?: string;
  /**
   * Start recording without a page click. `--record` has already named the
   * file, so a person who opens the window and closes it later expects one.
   */
  recordOnStart?: boolean;
}

/** One row the page renders; `expiresInMs` is computed here, not in the page. */
interface ApprovalItem extends PendingApproval {
  expiresInMs: number;
}

function approvalItems(approvals: ApprovalStore): ApprovalItem[] {
  const now = Date.now();
  return approvals.pending().map((entry) => ({
    ...entry,
    expiresInMs: Math.max(0, entry.expiresAt - now),
  }));
}

/**
 * The console's protocol over the viewer socket.
 *
 * The viewer answers its own message types first, so nothing here can shadow
 * streaming, input or privacy. Everything a person does to *governance* goes
 * through this hook, which means the console never invents a second path to
 * the lease or the approval files: it calls the same core functions the CLI
 * does.
 */
export function consoleHooks(deps: ConsoleDeps): ViewerHooks {
  const list = (client: ViewerClient): void => {
    client.send({ type: "console:approvals", items: approvalItems(deps.approvals) });
  };
  const fail = (client: ViewerClient, message: string): void => {
    client.send({ type: "console:error", message });
  };

  return {
    onClient(client) {
      // A tab that joins sees the current inbox and activity without waiting
      // for its first poll: an approval can expire in 60 s.
      list(client);
      void deps.activity().then(
        (items) => client.send({ type: "console:activity", items }),
        () => undefined,
      );
      // And the lease state: the button is a toggle, so a tab that opens while
      // a hold is in place must start at "Resume". Without this its first click
      // holds the device again and the person cannot hand it back.
      void deps.isHeld().then(
        (held) => client.send({ type: "console:held", held }),
        () => undefined,
      );
    },
    onMessage(client, message) {
      switch (message.type) {
        case "console:approvals:list":
          list(client);
          return true;
        // The poll asks for the lease too. Without this a second tab keeps
        // showing "Hold" after another tab resumed, and its next click holds
        // the device again instead of handing it back.
        case "console:held:list":
          void deps.isHeld().then(
            (held) => client.send({ type: "console:held", held }),
            () => undefined,
          );
          return true;
        case "console:approvals:decide": {
          const id = String(message.id ?? "");
          const decision = message.decision === "allow" ? "allow" : "deny";
          const scope =
            message.scope === "task" || message.scope === "always" ? message.scope : "once";
          // A failed write throws. Without this the throw escaped the hook into
          // the viewer's message handler: the tab got no frame at all and the
          // person believed their click was registered.
          let result;
          try {
            result = deps.approvals.decide(id, decision, {
              by: "console",
              ...(decision === "allow" ? { scope } : {}),
              ...(typeof message.reason === "string" && message.reason
                ? { reason: message.reason }
                : {}),
            });
          } catch (e) {
            list(client);
            fail(client, e instanceof Error ? e.message : String(e));
            return true;
          }
          // The list first, the reason last. A client that redraws the inbox
          // on every list frame would otherwise wipe the message in the same
          // tick it arrived — which is what a person clicking Deny on an
          // already-allowed id saw: the row came back and nothing explained
          // why their click did nothing.
          list(client);
          if (result.kind === "unknown") fail(client, result.reason ?? "unknown approval id");
          else if (result.kind === "expired") fail(client, result.reason ?? "approval expired");
          else if (result.kind === "already-used") fail(client, result.reason ?? "already used");
          else if (result.kind === "conflict") fail(client, result.reason ?? "already decided");
          return true;
        }
        case "console:hold":
          void deps.hold().then(
            (result) => {
              client.send({
                type: "console:held",
                held: true,
                ...(result.tookOverFrom ? { tookOverFrom: result.tookOverFrom } : {}),
              });
            },
            (e: unknown) => fail(client, e instanceof Error ? e.message : String(e)),
          );
          return true;
        case "console:resume":
          void deps.resume().then(
            () => client.send({ type: "console:held", held: false }),
            (e: unknown) => fail(client, e instanceof Error ? e.message : String(e)),
          );
          return true;
        case "console:activity":
          void deps.activity().then(
            (items) => client.send({ type: "console:activity", items }),
            (e: unknown) => fail(client, e instanceof Error ? e.message : String(e)),
          );
          return true;
        default:
          return false;
      }
    },
  };
}

/** Starts the console page on top of core's viewer server. */
export async function createConsoleServer(opts: ConsoleOptions): Promise<ViewerServer> {
  return startViewerServer({
    port: opts.port ?? 7042,
    host: opts.host ?? "127.0.0.1",
    privacy: opts.privacy ?? true,
    source: opts.source,
    ...(opts.recordOnStart ? { recordOnStart: true } : {}),
    page: renderPlayerPage({
      title: "uitest-console",
      extraHtml: CONSOLE_HTML,
      extraScript: CONSOLE_SCRIPT,
    }),
    hooks: consoleHooks(opts),
  });
}
