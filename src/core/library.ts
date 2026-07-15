import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseSourcesJson, type SourcesJson } from "./artifacts.js";

/**
 * core/library.ts — read access to `<home>/library`, shared by the
 * browsing commands (list/show/copy/status) and preference aggregation.
 */

/** One library entry on disk. */
export interface LibraryEntry {
  slug: string;
  dir: string;
  oneshotPath: string;
  sources: SourcesJson;
}

/**
 * Read every library entry that has a parseable, schema-valid `sources.json`,
 * sorted by `authored_at` descending (newest first). Directories whose
 * sources.json is missing, unreadable, or fails validation are skipped here —
 * `status` surfaces them via {@link readLibraryIssues}.
 */
export function readLibrary(home: string): LibraryEntry[] {
  const libraryDir = path.join(home, "library");
  let dirs: string[];
  try {
    dirs = fs
      .readdirSync(libraryDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const entries: LibraryEntry[] = [];
  for (const slug of dirs) {
    const dir = path.join(libraryDir, slug);
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, "sources.json"), "utf8");
    } catch {
      continue; // no sources.json — flagged by status
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed JSON — flagged by status
    }
    const sources = parseSourcesJson(parsed);
    if (!sources) continue; // not a valid sources record — flagged by status
    entries.push({
      slug,
      dir,
      oneshotPath: path.join(dir, `${slug}.oneshot.md`),
      sources,
    });
  }

  entries.sort((a, b) => (b.sources.authored_at ?? "").localeCompare(a.sources.authored_at ?? ""));
  return entries;
}

/** A library directory whose sources.json could not be read/validated. */
export interface LibraryIssue {
  slug: string;
  reason: string;
}

/**
 * Report library directories that {@link readLibrary} skipped: missing,
 * unreadable, malformed, or schema-invalid `sources.json`. `status` surfaces
 * these so a broken entry is visible rather than silently absent.
 */
export function readLibraryIssues(home: string): LibraryIssue[] {
  const libraryDir = path.join(home, "library");
  let dirs: string[];
  try {
    dirs = fs
      .readdirSync(libraryDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const issues: LibraryIssue[] = [];
  for (const slug of dirs) {
    const sourcesPath = path.join(libraryDir, slug, "sources.json");
    let raw: string;
    try {
      raw = fs.readFileSync(sourcesPath, "utf8");
    } catch {
      issues.push({ slug, reason: "missing sources.json" });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      issues.push({ slug, reason: "sources.json is not valid JSON" });
      continue;
    }
    if (!parseSourcesJson(parsed)) {
      issues.push({ slug, reason: "sources.json failed schema validation" });
    }
  }
  return issues.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Find one entry by slug; null when absent. */
export function findEntry(home: string, slug: string): LibraryEntry | null {
  return readLibrary(home).find((e) => e.slug === slug) ?? null;
}

/**
 * Content hash of a written oneshot file — the basis of overwrite protection.
 * The author stage records this in `sources.json` at write time; a later
 * mismatch means the USER edited the file, and re-authoring must not silently
 * destroy their work.
 */
export function oneshotHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Has the user modified this entry's oneshot since it was authored?
 * False for entries with no recorded hash (nothing to compare) and for
 * unreadable files (missing files are a different failure, not an edit).
 */
export function isEdited(entry: LibraryEntry): boolean {
  const recorded = entry.sources.oneshot_hash;
  if (!recorded) return false;
  try {
    return oneshotHash(fs.readFileSync(entry.oneshotPath, "utf8")) !== recorded;
  } catch {
    return false;
  }
}

/** A parsed oneshot file: provenance comment, title heading, prompt body. */
export interface ParsedOneshot {
  provenance: string | null;
  title: string | null;
  /** The paste-able prompt itself (what `copy` puts on the clipboard). */
  body: string;
}

/**
 * Split a written oneshot file back into its three parts. The file format is
 * ours (provenance HTML comment + `# title` + body — see the author stage),
 * so plain string surgery is reliable.
 */
export function parseOneshot(content: string): ParsedOneshot {
  let rest = content;
  let provenance: string | null = null;
  const trimmed = rest.trimStart();
  if (trimmed.startsWith("<!--")) {
    const end = trimmed.indexOf("-->");
    if (end !== -1) {
      provenance = trimmed.slice(0, end + 3);
      rest = trimmed.slice(end + 3);
    }
  }
  rest = rest.trim();

  let title: string | null = null;
  if (rest.startsWith("# ")) {
    const nl = rest.indexOf("\n");
    title = (nl === -1 ? rest.slice(2) : rest.slice(2, nl)).trim();
    rest = nl === -1 ? "" : rest.slice(nl + 1);
  }

  return { provenance, title, body: rest.trim() };
}
