#!/usr/bin/env node
import { mirrorMain } from "./cli.js";
import { CORE_VERSION, VERSION } from "./version.js";

const [first] = process.argv.slice(2);
if (first === "--version" || first === "-v") {
  process.stdout.write(`uitest-mirror ${VERSION} (uitest-sdk ${CORE_VERSION})\n`);
} else {
  mirrorMain(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
