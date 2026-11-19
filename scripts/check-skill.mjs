#!/usr/bin/env node
/**
 * Fails when the bundled skill and the package disagree about commands.
 *
 * The skill is the only documentation an agent sees before calling the CLI,
 * and it is shipped inside the package — so a command added without a row (or
 * a row left behind after a rename) reaches the agent as a plausible call that
 * may not exist. The command list is read from the built core, not a copy.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMMANDS } from "uitest-sdk/commands";

const DEFAULT_DIR = resolve(import.meta.dirname, "..", "packages", "phone", "assets", "skill");

/** Rows of SKILL.md's Acting table name the command in the second cell. */
export function skillCommands(text) {
  const section = text.split(/^## Acting$/m)[1]?.split(/^## /m)[0] ?? "";
  const names = new Set();
  for (const line of section.split("\n")) {
    const match = /^\|[^|]*\|\s*`([a-z][a-z0-9-]*)\b/.exec(line);
    // `uitest-console` points at the separate product and is not a command.
    if (match && !match[1].startsWith("uitest-")) names.add(match[1]);
  }
  return [...names];
}

/** REFERENCE.md's Commands section has one `### name` heading per command. */
export function referenceCommands(text) {
  const section = text.split(/^## Commands$/m)[1]?.split(/^## /m)[0] ?? "";
  const names = [...section.matchAll(/^### ([a-z][a-z0-9-]*)$/gm)].map((m) => m[1]);
  return [...new Set(names)];
}

function compare(file, expected, actual, out) {
  const seen = new Set(actual);
  for (const name of expected) {
    if (!seen.has(name)) out.push(`${file}: missing ${name}`);
  }
  const known = new Set(expected);
  for (const name of seen) {
    if (!known.has(name)) out.push(`${file}: extra ${name}`);
  }
}

/**
 * The command that numbers its output — `inspect`.
 *
 * `screenshot` saves the plain frame; `inspect` draws a ref number next to each
 * element. A doc that tells the agent to read a ref off a screenshot sends it
 * looking for numbers that were never drawn, so it falls back to guessing
 * coordinates — measured on the calculator, whose operator keys have no text:
 * 182 calls across eight tasks, three of them over 250 s.
 */
const REF_ON_IMAGE = /screenshot[^.]{0,160}(?:ref number|numbers? drawn|drawn on it)/i;

/**
 * Flags a sentence that sends the agent to `screenshot` for ref numbers.
 *
 * Sentences, not lines or paragraphs: the claim wraps across lines in the
 * skill's bullet style, and a bullet list is one paragraph — a paragraph-level
 * check would be silenced by any neighbouring bullet that names `inspect`.
 * A sentence that also names `inspect` is describing the right command (the
 * skill's own warning reads "needs `inspect`, not `screenshot`").
 */
function checkRefClaims(text, out) {
  for (const sentence of text.replace(/\s+/g, " ").split(/(?<=[.。])\s+/)) {
    if (!REF_ON_IMAGE.test(sentence)) continue;
    if (sentence.includes("`inspect`")) continue;
    out.push("SKILL.md: screenshot does not draw ref numbers; use inspect");
    return;
  }
}

/** Violations for the docs in `dir`; an empty array means they agree. */
export function checkSkill(dir) {
  const expected = COMMANDS.map((command) => command.name).sort();
  const out = [];
  const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
  compare("SKILL.md", expected, skillCommands(skill), out);
  compare(
    "REFERENCE.md",
    expected,
    referenceCommands(readFileSync(join(dir, "REFERENCE.md"), "utf8")),
    out,
  );
  checkRefClaims(skill, out);
  return out.sort();
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (invoked) {
  const dir = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_DIR;
  let violations;
  try {
    violations = checkSkill(dir);
  } catch (e) {
    console.error(`skill check failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (violations.length) {
    console.error(violations.join("\n"));
    process.exit(1);
  }
  console.log("skill ok");
}
