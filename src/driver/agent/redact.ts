import { POLICY_WORDS, matchesWord } from "../../policy.js";

/** What a password field or a fully hidden value renders as. */
export const REDACTED = "••••••";

/**
 * Whether a label talks about a credential.
 *
 * Reuses the policy's own word list, so the screen and the gate agree on what
 * a credential is. Custom `policy.words.credentials` are still enforced by the
 * policy; redaction uses the built-in vocabulary.
 */
export function isCredentialText(text: string): boolean {
  return POLICY_WORDS.credentials.some((word) => matchesWord(text, word));
}

/**
 * Whether this text is talking about a code, even if the policy's credential
 * list is narrower ("Your code is 482913" would not block an action, but it is
 * still a code the agent must not read). Only called with the label in hand;
 * the digit requirement keeps ordinary prose about "code" untouched.
 */
export function isSecretContext(text: string): boolean {
  if (isCredentialText(text)) return true;
  if (!/\d{3,8}/.test(text)) return false;
  return /\bcode\b|动态码|短信码|确认码|安全码|校验码|激活码|验证码/i.test(text);
}

/**
 * Replaces the secret part of a label before the agent sees it.
 *
 * - A password field shows `REDACTED`, never its value.
 * - In a credential context, digit runs of 3–8 (one-time codes, PINs, CVVs)
 *   become bullets of the same length. The words around them stay: the policy
 *   still has to classify the step, and the words are not the secret.
 * - Outside such a context, numbers are left alone: order totals and prices
 *   are not codes.
 */
export function redactLabel(
  label: string,
  opts: { password?: boolean; context?: boolean } = {},
): string {
  if (!label) return label;
  if (opts.password) return REDACTED;
  if (!opts.context) return label;
  return label.replace(/\d{3,8}/g, (run) => "•".repeat(run.length));
}
