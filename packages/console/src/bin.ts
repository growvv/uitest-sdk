#!/usr/bin/env node
import { consoleMain } from "./cli.js";
import { CORE_VERSION, VERSION } from "./version.js";

const [first] = process.argv.slice(2);
if (first === "--version" || first === "-v") {
  process.stdout.write(`uitest-console ${VERSION} (uitest-sdk ${CORE_VERSION})\n`);
} else {
  consoleMain(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
