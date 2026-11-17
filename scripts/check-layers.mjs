import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Enforces the one-way edges the architecture depends on:
 *
 *   product → uitest-sdk (root or a declared subpath)
 *
 * A core that reaches for a product couples every consumer to a product; one
 * product reaching another makes "optional" a fiction. The check is static
 * text, deliberately: a dynamic specifier that defeats it also defeats
 * bundling, and the failure is loud at build time.
 */

const CORE = "uitest-sdk";
const PRODUCTS = ["uitest-phone", "uitest-console", "uitest-mirror"];

/** Files that belong to a product (CLI, MCP, skill install) and must not ship in core. */
const PRODUCT_CODE = /(^|\/)(bin|cli-main|mcp|mcp-register|install-skill|connect)\.ts$/;

const SPECIFIERS = [
  /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function isProduct(name) {
  return PRODUCTS.includes(name);
}

/** All import/export specifiers in a file, in source order, deduplicated. */
function specifiersOf(source) {
  const found = new Set();
  for (const pattern of SPECIFIERS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) found.add(match[1]);
  }
  return [...found];
}

function walk(dir, base = dir, out = []) {
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of names) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, base, out);
    else out.push(relative(base, path).split("\\").join("/"));
  }
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Package directories under `<root>/packages`, as absolute paths. */
function packageDirs(root) {
  const base = join(root, "packages");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(base, entry.name));
}

/**
 * Checks one repository tree. Returns every violation, sorted; an empty array
 * is clean. A missing `packages/` tree is clean: the check runs before the
 * split too.
 */
export function checkLayers(root) {
  const violations = new Set();

  for (const dir of packageDirs(root)) {
    const relDir = relative(root, dir).split("\\").join("/");
    const srcDir = join(dir, "src");
    const pkg = readJson(join(dir, "package.json"));
    const pkgName = typeof pkg?.name === "string" ? pkg.name : "";
    const isCore = pkgName === CORE || relDir.endsWith("/core");

    if (isCore && pkg && "bin" in pkg) {
      violations.add(`${relDir}/package.json declares bin`);
    }

    if (isCore) {
      for (const file of walk(srcDir, root)) {
        if (PRODUCT_CODE.test(file) || /(^|\/)live\/cli\.ts$/.test(file)) {
          violations.add(`${file} is product code in core`);
        }
      }
    }

    for (const file of walk(srcDir, root)) {
      if (!/\.(ts|tsx|mts|cts)$/.test(file)) continue;
      const source = readFileSync(join(root, file), "utf8");
      for (const specifier of specifiersOf(source)) {
        const name = packageOf(specifier);
        if (/^uitest-sdk\/(dist|src)(\/|$)/.test(specifier)) {
          violations.add(`${file} deep-imports ${specifier}`);
        }
        if (isCore && isProduct(name)) {
          violations.add(`${file} imports ${name}`);
        }
        if (!isCore && isProduct(name) && name !== pkgName) {
          violations.add(`${file} imports ${name}`);
        }
      }
    }

    if (!isCore && pkg && typeof pkg.dependencies === "object" && pkg.dependencies) {
      for (const dep of Object.keys(pkg.dependencies)) {
        if (isProduct(dep) && dep !== pkgName) {
          violations.add(`${relDir}/package.json depends on ${dep}`);
        }
      }
    }
  }

  return [...violations].sort();
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const root = process.argv[2] ?? process.cwd();
  const violations = checkLayers(root);
  if (violations.length === 0) {
    process.stdout.write("layers ok\n");
  } else {
    process.stderr.write(`${violations.join("\n")}\n`);
    process.exitCode = 1;
  }
}
