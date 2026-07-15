import type { Writable } from "node:stream";

/**
 * ui/epipe.ts — quiet EPIPE handling for piped output.
 *
 * When a downstream reader closes early (`cc-hindsight list | head`), writes to
 * our stdout/stderr raise EPIPE. That's normal Unix behavior, not a crash: exit
 * 0 quietly like cat/grep/ls rather than dumping a stack trace. Any other stream
 * error is genuinely unexpected and is re-thrown.
 *
 * Extracted from cli.ts so the branch is unit-testable without spawning a
 * process or wiring up a real broken pipe.
 */

/** The exit function shape (injectable for tests; defaults to process.exit). */
export type ExitFn = (code: number) => never;

/**
 * Build the EPIPE-aware error handler. On `EPIPE` it calls `exit(0)`; any other
 * error is re-thrown so it surfaces normally.
 */
export function epipeHandler(exit: ExitFn = process.exit as ExitFn) {
  return (err: NodeJS.ErrnoException): void => {
    if (err.code === "EPIPE") {
      exit(0);
      return; // real process.exit never returns; a test double might.
    }
    throw err;
  };
}

/** Attach the EPIPE handler to a stream's `error` event. */
export function installEpipeHandler(stream: Writable, exit: ExitFn = process.exit as ExitFn): void {
  stream.on("error", epipeHandler(exit));
}
