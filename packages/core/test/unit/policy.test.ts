import { describe, it, expect } from "vitest";
import { Policy, DEFAULT_CONFIRM } from "../../src/governance/policy.js";

const policy = (opts = {}) => new Policy(opts);

describe("Policy: risk rules", () => {
  it("blocks a credential field regardless of the confirm list", () => {
    const p = policy({ confirm: "none" });
    expect(p.check({ action: "type", labels: ["支付密码"] }))
      .toMatchObject({ kind: "block", rule: "credentials" });
    expect(p.check({ action: "type", labels: ["Password"] }))
      .toMatchObject({ kind: "block", rule: "credentials" });
  });

  it("blocks a password input even when the label says nothing", () => {
    const p = policy({ confirm: "none" });
    const node = { attributes: { textInputType: "Password" } };
    expect(p.check({ action: "type", labels: ["输入"], node }))
      .toMatchObject({ kind: "block", rule: "credentials" });
  });

  it("asks for approval on the default rules only", () => {
    const p = policy();
    expect(p.check({ action: "tap", labels: ["确认支付"] })).toMatchObject({ kind: "approval", rule: "payments" });
    expect(p.check({ action: "tap", labels: ["银行"] })).toMatchObject({ kind: "approval", rule: "finance" });
    // Deleting and sending are irreversible or outward-facing, so they ask by
    // default — an agent must not delete a photo or send a message on its own.
    expect(p.check({ action: "tap", labels: ["删除"] })).toMatchObject({ kind: "approval", rule: "deletes" });
    expect(p.check({ action: "tap", labels: ["发送"] })).toMatchObject({ kind: "approval", rule: "sends" });
    // "确认" alone is not on the default list: an ordinary form button must not block.
    expect(p.check({ action: "tap", labels: ["确认"] })).toEqual({ kind: "allow" });
    expect([...DEFAULT_CONFIRM]).toEqual(["payments", "finance", "deletes", "sends"]);
  });

  it("lets a caller narrow the default set back to payments and finance", () => {
    const p = policy({ confirm: ["payments", "finance"] });
    expect(p.check({ action: "tap", labels: ["删除"] })).toEqual({ kind: "allow" });
    expect(p.check({ action: "tap", labels: ["发送"] })).toEqual({ kind: "allow" });
  });

  it("widens to every rule with confirm: all", () => {
    const p = policy({ confirm: "all" });
    expect(p.check({ action: "tap", labels: ["发送"] })).toMatchObject({ kind: "approval", rule: "sends" });
    expect(p.check({ action: "tap", labels: ["保存"] })).toMatchObject({ kind: "approval", rule: "commits" });
  });

  it("matches whole words in Latin text so 'payment' does not fire on 'paymentslip'", () => {
    const p = policy();
    expect(p.check({ action: "tap", labels: ["payment"] })).toMatchObject({ kind: "approval" });
    expect(p.check({ action: "tap", labels: ["paymentslip"] })).toEqual({ kind: "allow" });
  });

  it("matches substrings for Chinese labels", () => {
    const p = policy();
    expect(p.check({ action: "tap", labels: ["立即付款"] })).toMatchObject({ kind: "approval", rule: "payments" });
  });

  it("allows an ordinary button", () => {
    expect(policy().check({ action: "tap", labels: ["WLAN"] })).toEqual({ kind: "allow" });
  });

  it("does not classify an empty label set", () => {
    expect(policy().check({ action: "tap", labels: [] })).toEqual({ kind: "allow" });
  });
});

describe("Policy: read-only", () => {
  it("blocks typing unless the field looks like a search box", () => {
    const p = policy({ readOnly: true });
    expect(p.check({ action: "type", labels: ["名称"] }))
      .toMatchObject({ kind: "block", rule: "read-only" });
    expect(p.check({ action: "type", labels: ["搜索"] })).toEqual({ kind: "allow" });
  });

  it("blocks anything that would have needed approval", () => {
    const p = policy({ readOnly: true, confirm: "all" });
    expect(p.check({ action: "tap", labels: ["删除"] }))
      .toMatchObject({ kind: "block", rule: "read-only" });
  });

  it("still allows navigation and reading", () => {
    const p = policy({ readOnly: true });
    expect(p.check({ action: "tap", labels: ["WLAN"] })).toEqual({ kind: "allow" });
    expect(p.check({ action: "swipe", labels: [] })).toEqual({ kind: "allow" });
  });
});

describe("Policy: app scope", () => {
  it("allows the declared apps and system chrome", () => {
    const p = policy({ apps: ["com.huawei.hmos.settings"] });
    expect(p.scope("com.huawei.hmos.settings")).toEqual({ kind: "allow" });
    expect(p.scope("com.ohos.sceneboard")).toEqual({ kind: "allow" });
    expect(p.scope("com.huawei.hmos.systemui")).toEqual({ kind: "allow" });
  });

  it("blocks an app outside the list", () => {
    const p = policy({ apps: ["com.huawei.hmos.settings"] });
    expect(p.scope("com.example.bank")).toMatchObject({ kind: "block", rule: "scope" });
  });

  it("allows everything when no list is given", () => {
    expect(policy().scope("com.example.bank")).toEqual({ kind: "allow" });
  });
});

describe("Policy: customisation", () => {
  it("accepts extra words for a rule", () => {
    const p = policy({ confirm: ["commits"], words: { commits: ["上传"] } });
    expect(p.check({ action: "tap", labels: ["上传"] })).toMatchObject({ kind: "approval", rule: "commits" });
  });

  it("reports which word matched, for the approval message", () => {
    const p = policy();
    const d = p.check({ action: "tap", labels: ["确认支付"] });
    expect(d.kind).toBe("approval");
    expect(d.kind === "approval" && d.reason).toContain("支付");
  });

  it("describes itself for doctor output", () => {
    const p = policy({ readOnly: true, confirm: ["deletes"], apps: ["com.a.b"] });
    expect(p.describe()).toEqual({
      readOnly: true,
      confirm: ["deletes"],
      apps: ["com.a.b"],
      allowCredentials: false,
    });
  });
});
