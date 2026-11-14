import { describe, it, expect } from "vitest";
import { UitestError, AgentProtocolError, AgentBusyError } from "../../src/errors.js";

describe("errors", () => {
  it("carries code and cause", () => {
    const cause = new Error("inner");
    const e = new AgentProtocolError("device said no", "EPROTO", cause);
    expect(e).toBeInstanceOf(UitestError);
    expect(e.code).toBe("EPROTO");
    expect(e.cause).toBe(cause);
    expect(e.message).toBe("device said no");
    expect(e.name).toBe("AgentProtocolError");
  });

  it("AgentBusyError is a distinct subclass", () => {
    const e = new AgentBusyError("device stayed busy", "EBUSY");
    expect(e).toBeInstanceOf(UitestError);
    expect(e).not.toBeInstanceOf(AgentProtocolError);
    expect(e.name).toBe("AgentBusyError");
  });
});
