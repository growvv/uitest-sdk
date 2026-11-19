import type { UiNode } from "../transport/model.js";

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
   * or an array. Defaults to payments, finance, deletes and sends.
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

/**
 * Rules that ask a person before the step runs.
 *
 * Payments and finance are obvious. Deleting and sending are here because
 * they are the two ways an agent can do something a person cannot take back:
 * a deleted file is gone, and a sent message has left the phone. `commits`
 * (确认 / 保存) stays opt-in — it is the label of half the ordinary form
 * buttons on a phone, and asking on every one of them would train a person to
 * approve without reading.
 */
export const DEFAULT_CONFIRM: ConfirmRule[] = ["payments", "finance", "deletes", "sends"];

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

/**
 * A control names its action in a few words — 发布, 发布笔记, 立即付款, 发送给
 * 朋友. A feed row is a sentence someone is reading: a Zhihu question whose
 * label is the whole title plus the excerpt. The risk word in that sentence
 * describes content, not what the tap does.
 *
 * Element type does not separate them — Zhihu renders the row as a clickable
 * container, so its role is `button` like a real one — but the label's shape
 * does: a name is short and its verb comes first. Chinese packs more meaning
 * into a character than Latin does, so a Latin label gets twice the budget.
 */
const CONTROL_LABEL_MAX_CJK = 24;

/**
 * How much may come before the verb in a control label — 立即付款, 确认支付,
 * 一键发布, 点击发送. A verb buried deeper is a word inside a sentence.
 */
const CONTROL_LEAD_MAX = 4;

/** Steps whose labels describe the thing being touched rather than text typed. */
const TOUCHING = new Set(["tap", "double-click", "long-press", "swipe", "drag", "fling", "pinch"]);

/** System UI a task must be allowed to touch to get anywhere. */
const SYSTEM_CHROME = new Set([
  "com.huawei.hmos.sceneboard",
  "com.ohos.sceneboard",
  "com.huawei.hmos.systemui",
  "com.ohos.systemui",
]);

const CJK = /[㐀-鿿]/;

/** A word written in Latin letters: it has boundaries, unlike Chinese. */
function isLatin(word: string): boolean {
  return !CJK.test(word) && !/[^\x00-\x7f]/.test(word);
}

/** Chinese has no word boundaries; Latin needs them or "pay" fires inside "paypal". */
function matches(text: string, word: string): boolean {
  const haystack = text.toLowerCase();
  const needle = word.toLowerCase();
  if (!needle) return false;
  if (CJK.test(needle) || /[^\x00-\x7f]/.test(needle)) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * Where a word starts in a label, or -1. Latin words respect boundaries the
 * way `matches` does; Chinese has none, so this is a plain search.
 */
function indexOfWord(text: string, word: string): number {
  const haystack = text.toLowerCase();
  const needle = word.toLowerCase();
  if (!needle) return -1;
  if (CJK.test(needle) || /[^\x00-\x7f]/.test(needle)) return haystack.indexOf(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").exec(haystack);
  return m ? m.index + m[1]!.length : -1;
}

/** A label's length in CJK characters; Latin is about twice as dense. */
function widthOf(text: string): number {
  let width = 0;
  for (const ch of text) width += CJK.test(ch) ? 1 : 0.5;
  return width;
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

  /**
   * The labels of a touched element that could be a control's name.
   *
   * A feed row's label is a sentence; a control's label is a name. A label
   * short enough to be a name, whose risk word sits near the front, is a name
   * — 发布, 发布笔记, 立即付款, 确认支付，¥199. Anything else is content, and a
   * risk word inside it is not something the tap does.
   */
  controlLabels(labels: string[]): string[] {
    return labels.filter((label) => this.isControlLabel(label));
  }

  private isControlLabel(label: string): boolean {
    const text = String(label ?? "").trim();
    if (!text) return false;
    // Count in CJK characters: 24 characters of Chinese is a sentence; 48
    // characters of Latin is the same amount of meaning.
    if (widthOf(text) > CONTROL_LABEL_MAX_CJK) return false;
    for (const rule of RULE_ORDER) {
      for (const word of this.words[rule]) {
        const at = indexOfWord(text, word);
        if (at < 0) continue;
        // Chinese has no word boundaries, so a verb can sit inside a longer
        // word. Position is what separates a name from a sentence: a control
        // leads with its verb, a feed row mentions it somewhere in the text.
        // Latin words are bounded, so "…history delete button" is unambiguous
        // wherever the verb sits.
        if (isLatin(word)) return true;
        if (at >= CONTROL_LEAD_MAX) continue;
        // "35人付款", "1101万人购买过" — a count of people in front of the verb
        // is a product card's social proof, not a button.
        if (text.slice(0, at).includes("人")) continue;
        return true;
      }
    }
    return false;
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
    // A step that touches the screen is judged on what it touches. The labels
    // of a feed row are the sentence being read, so a risk word inside one is
    // content, not an action; only a label shaped like a control's name can
    // mean the tap performs that action.
    const labels = TOUCHING.has(check.action) ? this.controlLabels(check.labels) : check.labels;
    // Typing is not in TOUCHING, so a password field is still judged on its raw
    // labels; the input type below catches the ones whose label says nothing.
    const credential = this.credentialReason(labels, check.node);
    if (credential && !this.allowCredentials) {
      return { kind: "block", rule: "credentials", reason: credential };
    }
    if (this.readOnly && check.action === "type" && !looksLikeSearch(check.labels)) {
      return { kind: "block", rule: "read-only", reason: "typing is disabled in read-only mode" };
    }
    const risk = this.classify(labels);
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

export { RULES as POLICY_WORDS, SYSTEM_CHROME, matches as matchesWord };
