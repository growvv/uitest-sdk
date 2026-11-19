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

  it("does not fire on a feed row whose label is a sentence", () => {
    // Zhihu renders a question row as a clickable container, so its label is
    // the whole question plus the excerpt. The word 发布 there is content the
    // person is reading, not an action the tap performs. Tapping the row
    // stopped the task on a send approval nobody asked for.
    const p = policy();
    expect(
      p.check({
        action: "tap",
        labels: [
          "鸿蒙 7 开发者 beta 正式发布，此次版本更新带来了哪些功能改进与技术突破？, 酱紫君：在过去，做操作系统一直被认为是九死一生的苦差事",
        ],
      }),
    ).toEqual({ kind: "allow" });
    expect(
      p.check({ action: "tap", labels: ["如何评价某公司发布的新一代产品？", "关注", "1203 个回答"] }),
    ).toEqual({ kind: "allow" });
  });

  it("does not fire on a social-proof count", () => {
    // "35人付款" and "1101万人购买过" sit inside a product card. They are
    // short and carry the verb early, so the shape test alone would call them
    // controls; a leading count of people is a statistic, not an instruction.
    const p = policy();
    for (const label of ["35人付款", "400+人付款", "1101万人购买过", "2万+人付款", "10万+人付款"]) {
      expect(p.check({ action: "tap", labels: [label] }), label).toEqual({ kind: "allow" });
    }
  });

  it("still fires on a short control whose label starts with a number", () => {
    // A count of people is a statistic; "1 键发布" is a button.
    expect(policy().check({ action: "tap", labels: ["1 键发布"] })).toMatchObject({ kind: "approval", rule: "sends" });
  });

  it("finds a Latin verb anywhere in a short control label", () => {
    // Accessibility labels are assembled from resource ids: "Button:search
    // history delete button" is the delete control, and its verb is not at the
    // front. Latin words have boundaries, so the position does not matter.
    expect(policy().check({ action: "tap", labels: ["Button:search history delete button"] })).toMatchObject({
      kind: "approval",
      rule: "deletes",
    });
  });

  it("still fires on a control that would publish", () => {
    expect(policy().check({ action: "tap", labels: ["发布"] })).toMatchObject({ kind: "approval", rule: "sends" });
  });

  it("still fires on a publish control whose label names the action", () => {
    // Xiaohongshu and Weibo put the action inside a short label.
    expect(policy().check({ action: "tap", labels: ["发布笔记"] })).toMatchObject({ kind: "approval", rule: "sends" });
    expect(policy().check({ action: "tap", labels: ["发送给朋友"] })).toMatchObject({ kind: "approval", rule: "sends" });
  });

  it("keeps firing when a short control label carries a price", () => {
    // A control label may hold a number; only sentences are content.
    expect(policy().check({ action: "tap", labels: ["确认支付，¥199"] })).toMatchObject({
      kind: "approval",
      rule: "payments",
    });
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
