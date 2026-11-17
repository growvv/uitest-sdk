import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkSkill } from "../../../../scripts/check-skill.mjs";

const skillDir = fileURLToPath(new URL("../../assets/skill", import.meta.url));

function copySkill(): string {
  const dir = mkdtempSync(join(tmpdir(), "uitest-skill-"));
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(skillDir, "SKILL.md"), join(dir, "SKILL.md"));
  copyFileSync(join(skillDir, "REFERENCE.md"), join(dir, "REFERENCE.md"));
  return dir;
}

describe("skill command index", () => {
  it("lists exactly the commands the package implements", () => {
    expect(checkSkill(skillDir)).toEqual([]);
  });

  it("fails when a command is missing from a doc", () => {
    const dir = copySkill();
    const path = join(dir, "SKILL.md");
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text.replace("| Read the screen | `observe` |\n", ""));

    expect(checkSkill(dir)).toContain("SKILL.md: missing observe");
  });

  it("fails when a doc lists a command the package does not have", () => {
    const dir = copySkill();
    const path = join(dir, "SKILL.md");
    const text = readFileSync(path, "utf8");
    writeFileSync(
      path,
      text.replace("| Goal | Command |\n", "| Goal | Command |\n| Nonsense | `bogus` |\n"),
    );

    expect(checkSkill(dir)).toContain("SKILL.md: extra bogus");
  });
});
