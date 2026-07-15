import fs from "node:fs";

/**
 * core/fsutil.ts — owner-only writes for the private data directory.
 *
 * Exports contain "anything sensitive you ever pasted into a session" (README),
 * yet default file modes are world-readable (0644). A tool this explicit about
 * the sensitivity of its output should keep `~/.cc-hindsight` and everything
 * under it readable only by its owner. POSIX only — Node ignores `mode` on
 * Windows, which is a harmless no-op there.
 */

/** Owner-only directory mode (rwx------). */
export const DIR_MODE = 0o700;
/** Owner-only file mode (rw-------). */
export const FILE_MODE = 0o600;

/** `mkdir -p` with owner-only mode; best-effort chmod of the leaf for pre-existing dirs. */
export function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    fs.chmodSync(dir, DIR_MODE); // mkdirSync's mode applies on create only — tighten pre-existing dirs
  } catch {
    // not owner / unsupported (e.g. Windows) — mode is best-effort
  }
}

/** Write a file owner-only; chmod after write so pre-existing files are tightened too. */
export function writeFilePrivate(file: string, data: string): void {
  fs.writeFileSync(file, data, { mode: FILE_MODE });
  try {
    fs.chmodSync(file, FILE_MODE); // writeFileSync's mode only applies on create
  } catch {
    // not owner / unsupported — best-effort
  }
}
