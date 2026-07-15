#!/usr/bin/env node
/**
 * scripts/check-pack.mjs — assert the npm tarball contains exactly what we
 * intend to ship. Trust story: a user auditing the package should find
 * dist + metadata, never source, tests, fixtures, or CI config.
 *
 * Usage: npm pack --dry-run --json > pack.json && node scripts/check-pack.mjs pack.json
 */
import fs from "node:fs";

const input = process.argv[2];
if (!input) {
  console.error("usage: check-pack.mjs <pack-json-file>");
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(input, "utf8"));
const files = report[0].files.map((f) => f.path).sort();

// Everything shipped must match one of these.
const allowed = [
  /^dist\//,
  /^package\.json$/,
  /^npm-shrinkwrap\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
];
// These must be present for the package to work / be trustworthy.
const required = ["dist/cli.js", "package.json", "npm-shrinkwrap.json", "README.md", "LICENSE"];

const unexpected = files.filter((f) => !allowed.some((re) => re.test(f)));
const missing = required.filter((r) => !files.includes(r));

if (unexpected.length > 0) {
  console.error(`unexpected files in package:\n  ${unexpected.join("\n  ")}`);
}
if (missing.length > 0) {
  console.error(`required files missing from package:\n  ${missing.join("\n  ")}`);
}
if (unexpected.length > 0 || missing.length > 0) process.exit(1);

console.log(`package contents OK (${files.length} files, all expected).`);
