import fs from "node:fs";
import path from "node:path";
import type { SourcesJson } from "../distill/pipeline.js";

/**
 * core/library.ts — read access to `<home>/library` (§5.3), shared by the
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
 * Read every library entry that has a parseable `sources.json`, sorted by
 * `authored_at` descending (newest first). Directories without one are
 * ignored here — `status` surfaces inconsistencies.
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
    try {
      const sources = JSON.parse(
        fs.readFileSync(path.join(dir, "sources.json"), "utf8"),
      ) as SourcesJson;
      entries.push({
        slug,
        dir,
        oneshotPath: path.join(dir, `${slug}.oneshot.md`),
        sources,
      });
    } catch {
      // unreadable entry — skipped here, flagged by status
    }
  }

  entries.sort((a, b) => (b.sources.authored_at ?? "").localeCompare(a.sources.authored_at ?? ""));
  return entries;
}

/** Find one entry by slug; null when absent. */
export function findEntry(home: string, slug: string): LibraryEntry | null {
  return readLibrary(home).find((e) => e.slug === slug) ?? null;
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
