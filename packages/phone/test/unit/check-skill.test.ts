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

  // `screenshot` saves the plain frame; only `inspect` numbers the elements.
  // A doc that sends the agent to `screenshot` to find a ref sends it looking
  // for numbers that were never drawn — the exact loop that burned 80 calls on
  // the calculator's unlabelled operator keys.
  it("fails when a doc says a screenshot carries ref numbers", () => {
    const dir = copySkill();
    const path = join(dir, "SKILL.md");
    const text = readFileSync(path, "utf8");
    // The sentence this release removed, verbatim.
    const old =
      "`screenshot` returns the pixels, so look at the image, match the symbol to the ref number drawn on it, then tap that ref.";
    const at = text.indexOf("`observe --out shot.jpg`");
    expect(at).toBeGreaterThan(-1);
    // Inserted, not sliced: the anchor contains a dot in "shot.jpg", and
    // cutting at the next "." would land inside the file name.
    writeFileSync(path, text.slice(0, at) + old + " " + text.slice(at));

    expect(checkSkill(dir)).toContain("SKILL.md: screenshot does not draw ref numbers; use inspect");
  });

  // The dialer's bundle (`com.ohos.callui`, label 电话) declares five page
  // abilities and not one is exported, so `aa start` refuses every one of them
  // with 10103001. An agent that reads "Open an app by its on-screen name" and
  // tries 电话 burns a call on a launch that cannot succeed on any device. The
  // skill has to say where the dialer actually lives.
  it("names the bundle that opens the dialer", () => {
    const dir = copySkill();
    const text = readFileSync(join(dir, "SKILL.md"), "utf8");

    expect(text).toContain("com.ohos.contacts");
  });

  // `type` appends. The agent's only recourse before `--clear` was one
  // backspace per character, on a search box that re-runs its query after every
  // press: meituan-05 spent 21 taps and 3 backspaces on one field and then hit
  // the 480 s timeout. The flag is useless if the skill never mentions it.
  it("tells the agent to clear a field instead of deleting it character by character", () => {
    const dir = copySkill();
    const text = readFileSync(join(dir, "SKILL.md"), "utf8");

    expect(text).toContain("--clear");
  });
});
