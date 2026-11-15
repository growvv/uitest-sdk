import { describe, it, expect } from "vitest";
import { REDACTED, isCredentialText, isSecretContext, redactLabel } from "../../src/agent/redact.js";

describe("redactLabel", () => {
  it("masks the digits of a one-time code and keeps the sentence", () => {
    // The agent may know that a code arrived; it must not get the code.
    expect(redactLabel("Your code is 482913", { context: true })).toBe("Your code is ••••••");
  });

  it("keeps the word the policy classifies", () => {
    // The policy still has to recognise a credential step by its label, so
    // masking must never remove the words 验证码 / password / OTP.
    expect(redactLabel("验证码 482913", { context: true })).toBe("验证码 ••••••");
  });

  it("leaves a number alone when nothing marks it as a credential", () => {
    expect(redactLabel("订单 482913", { context: false })).toBe("订单 482913");
    expect(redactLabel("¥482913", {})).toBe("¥482913");
  });

  it("masks a password field entirely", () => {
    expect(redactLabel("hunter2", { password: true })).toBe(REDACTED);
  });

  it("keeps the length of spaced code groups", () => {
    expect(redactLabel("code 482 913", { context: true })).toBe("code ••• •••");
  });

  it("does not turn a lone 1 or 2 digit number into bullets", () => {
    expect(redactLabel("验证码有效期 5 分钟", { context: true })).toBe("验证码有效期 5 分钟");
  });
});

describe("isCredentialText", () => {
  it("recognises the words the policy already blocks", () => {
    for (const text of ["密码", "验证码", "password", "verification code", "OTP"]) {
      expect(isCredentialText(text)).toBe(true);
    }
    expect(isCredentialText("订单 482913")).toBe(false);
  });
});

describe("isSecretContext", () => {
  it("catches a code sentence the policy's credential list is too narrow for", () => {
    expect(isSecretContext("Your code is 482913")).toBe(true);
    expect(isSecretContext("订单 482913")).toBe(false);
  });

  it("leaves prose about code without digits alone", () => {
    expect(isSecretContext("Code review notes")).toBe(false);
  });
});
