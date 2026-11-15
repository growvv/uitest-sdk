import type { UiNode } from "./model.js";

export type Rule = "credentials" | "payments" | "finance" | "deletes" | "sends" | "commits";
export type ConfirmRule = Exclude<Rule, "credentials">;

export type Decision =
  | { kind: "allow" }
  | { kind: "block"; rule: string; reason: string }
  | { kind: "approval"; rule: ConfirmRule; reason: string };

export interface PolicyOptions {
  /** Refuse anything that would otherwise need approval. */
  readOnly?: boolean;
  /**
   * Rules that need a person's approval first. `"none"`, `"all"`, a comma list,
   * or an array. Defaults to payments and finance.
   */
  confirm?: string | ConfirmRule[];
  /** Bundle allow-list. System chrome is always allowed. */
  apps?: string[];
  /** Extra words per rule, merged with the built-in list. */
  words?: Partial<Record<Rule, string[]>>;
  /** Permit typing into credential fields. Off by default. */
  allowCredentials?: boolean;
}

export interface PolicyCheck {
  /** What the step does: `tap`, `type`, `swipe`, `key`, `launch`, ... */
  action: string;
  /** Every label under the target, used for classification. */
  labels: string[];
  /** The raw node, for input-type checks the labels do not reveal. */
  node?: UiNode | null;
}

export const DEFAULT_CONFIRM: ConfirmRule[] = ["payments", "finance"];

const RULE_ORDER: Rule[] = ["credentials", "payments", "finance", "deletes", "sends", "commits"];

/**
 * Words that make an action hard to undo or expensive. Deliberately blunt: it
 * does not try to understand an app, only to notice the vocabulary of payment,
 * deletion and sending. Every match names the word that fired, so the approval
 * message can show why.
 */
const RULES: Record<Rule, string[]> = {
  credentials: [
    "密码", "口令", "验证码", "动态码", "短信码", "支付密码", "解锁密码",
    "password", "passcode", "pin code", "pin", "otp", "one-time code",
    "verification code", "2fa", "mfa",
  ],
  payments: [
    "支付", "付款", "购买", "下单", "结算", "转账", "汇款", "提现", "充值", "买入", "卖出",
    "赎回", "还款", "借款", "质押", "打赏", "付费", "续费", "订阅",
    "pay", "payment", "buy", "purchase", "checkout", "place order", "confirm order",
    "transfer", "withdraw", "deposit", "top up", "trade", "stake", "repay", "borrow",
  ],
  finance: [
    "银行", "钱包", "支付宝", "证券", "股票", "基金", "理财", "保险", "信用卡",
    "bank", "wallet", "alipay", "paypal", "venmo", "cash app", "broker", "trading", "finance",
  ],
  deletes: [
    "删除", "移除", "卸载", "清空", "重置", "格式化", "注销", "退出登录", "销毁",
    "delete", "remove", "uninstall", "clear", "reset", "erase", "sign out", "log out",
  ],
  sends: [
    "发送", "发消息", "发布", "提交", "寄出", "回复",
    "send", "post", "publish", "submit", "reply",
  ],
  commits: [
    "确认", "确定", "完成", "保存", "同意", "允许", "安装", "更新", "预约", "预订",
    "confirm", "ok", "done", "save", "agree", "allow", "install", "update", "book", "reserve",
  ],
};

const SEARCH_WORDS = ["搜索", "查找", "search", "find"];

/** System UI a task must be allowed to touch to get anywhere. */
const SYSTEM_CHROME = new Set([
  "com.huawei.hmos.sceneboard",
  "com.ohos.sceneboard",
  "com.huawei.hmos.systemui",
  "com.ohos.systemui",
]);

const CJK = /[㐀-鿿]/;

/** Chinese has no word boundaries; Latin needs them or "pay" fires inside "paypal". */
function matches(text: string, word: string): boolean {
  const haystack = text.toLowerCase();
  const needle = word.toLowerCase();
  if (!needle) return false;
  if (CJK.test(needle) || /[^\x00-\x7f]/.test(needle)) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

function parseConfirm(value: string | ConfirmRule[] | undefined): Set<ConfirmRule> {
  if (Array.isArray(value)) return new Set(value);
  if (value === undefined) return new Set(DEFAULT_CONFIRM);
  const parts = value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.includes("none")) return new Set();
  if (parts.includes("all")) return new Set(["payments", "finance", "deletes", "sends", "commits"]);
  const out = new Set<ConfirmRule>();
  for (const part of parts) {
    if (part !== "credentials" && (RULE_ORDER as string[]).includes(part)) out.add(part as ConfirmRule);
  }
  return out;
}

/**
 * Refuses, asks, or allows — before the device is touched.
 *
 * The policy is a separate object rather than a check inside `click()` so a
 * caller can run it without a device, test it, and replace it. The session
 * consults it; nothing else needs to know the rules.
 */
export class Policy {
  readonly readOnly: boolean;
  readonly allowCredentials: boolean;
  readonly confirm: Set<ConfirmRule>;
  private readonly apps: string[];
  private readonly words: Record<Rule, string[]>;

  constructor(opts: PolicyOptions = {}) {
    this.readOnly = opts.readOnly === true;
    this.allowCredentials = opts.allowCredentials === true;
    this.confirm = parseConfirm(opts.confirm);
    this.apps = (opts.apps ?? []).map((a) => a.toLowerCase()).filter(Boolean);
    this.words = { ...RULES };
    for (const [rule, extra] of Object.entries(opts.words ?? {})) {
      if (!extra?.length) continue;
      this.words[rule as Rule] = [...RULES[rule as Rule], ...extra];
    }
  }

  /** Classifies the text of a step. Returns the first rule that matches. */
  classify(labels: string[]): { rule: Rule; matched: string } | null {
    const text = labels.filter(Boolean).join(" \n ");
    if (!text.trim()) return null;
    for (const rule of RULE_ORDER) {
      for (const word of this.words[rule]) {
        if (matches(text, word)) return { rule, matched: word };
      }
    }
    return null;
  }

  credentialReason(labels: string[], node?: UiNode | null): string | null {
    const text = labels.filter(Boolean).join(" \n ");
    for (const word of this.words.credentials) {
      if (matches(text, word)) return `credential field (${word})`;
    }
    const inputType = String(node?.attributes?.["textInputType"] ?? node?.attributes?.["inputType"] ?? "");
    if (/password|visiblePassword|numberPassword/i.test(inputType)) {
      return `credential field (${inputType})`;
    }
    return null;
  }

  /** The decision for one step, before anything is sent to the device. */
  check(check: PolicyCheck): Decision {
    const credential = this.credentialReason(check.labels, check.node);
    if (credential && !this.allowCredentials) {
      return { kind: "block", rule: "credentials", reason: credential };
    }
    if (this.readOnly && check.action === "type" && !looksLikeSearch(check.labels)) {
      return { kind: "block", rule: "read-only", reason: "typing is disabled in read-only mode" };
    }
    const risk = this.classify(check.labels);
    if (!risk) return { kind: "allow" };
    if (this.readOnly) {
      return { kind: "block", rule: "read-only", reason: `${risk.rule}: ${risk.matched}` };
    }
    if (risk.rule === "credentials") {
      return { kind: "block", rule: "credentials", reason: `credential field (${risk.matched})` };
    }
    if (this.confirm.has(risk.rule)) {
      return { kind: "approval", rule: risk.rule, reason: `matched "${risk.matched}"` };
    }
    return { kind: "allow" };
  }

  /** Whether a bundle is inside the task's allow-list. */
  scope(bundle: string): Decision {
    const b = String(bundle ?? "").toLowerCase();
    if (this.apps.length === 0 || SYSTEM_CHROME.has(b)) return { kind: "allow" };
    if (this.apps.includes(b)) return { kind: "allow" };
    return {
      kind: "block",
      rule: "scope",
      reason: `${bundle} is outside the task's app list (${this.apps.join(", ")})`,
    };
  }

  describe(): {
    readOnly: boolean;
    confirm: ConfirmRule[];
    apps: string[];
    allowCredentials: boolean;
  } {
    return {
      readOnly: this.readOnly,
      confirm: [...this.confirm],
      apps: [...this.apps],
      allowCredentials: this.allowCredentials,
    };
  }
}

function looksLikeSearch(labels: string[]): boolean {
  const text = labels.filter(Boolean).join(" \n ");
  return SEARCH_WORDS.some((word) => matches(text, word));
}

export { RULES as POLICY_WORDS, SYSTEM_CHROME };
