import { spawn as nodeSpawn } from "node:child_process";

/**
 * ui/clipboard.ts — the ~10-line clipboard helper: pick the platform's
 * clipboard tool, pipe text to it. All process interaction is injectable so
 * tests never touch a real clipboard.
 */

/** The clipboard command for a platform (Wayland preferred over X11 on Linux). */
export function clipboardCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "pbcopy", args: [] };
  if (platform === "win32") return { cmd: "clip", args: [] };
  if (env.WAYLAND_DISPLAY) return { cmd: "wl-copy", args: [] };
  return { cmd: "xclip", args: ["-selection", "clipboard"] };
}

/** Minimal spawn surface the helper needs (injectable). */
export type ClipboardSpawn = (
  cmd: string,
  args: string[],
  input: string,
) => Promise<{ code: number | null; error?: string }>;

const defaultSpawn: ClipboardSpawn = (cmd, args, input) =>
  new Promise((resolve) => {
    const child = nodeSpawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    let settled = false;
    const settle = (v: { code: number | null; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    child.on("error", (err) => settle({ code: null, error: err.message }));
    // `exit` as well as `close`: a clipboard tool that forks a helper holding the
    // pipe would otherwise keep this promise open (same trap as the runner spawn).
    child.on("close", (code) => settle({ code }));
    child.on("exit", (code) => settle({ code }));
    // The tool may exit before the text is fully written (ENOENT, no display),
    // which raises EPIPE on stdin; with no listener that is an uncaught throw.
    child.stdin?.on("error", () => {});
    child.stdin?.write(input);
    child.stdin?.end();
  });

/**
 * How long to wait for a clipboard tool before giving up.
 *
 * A clipboard tool can HANG rather than fail: `xclip` with no usable X display
 * holds the selection indefinitely instead of exiting. The copy offer is the last
 * thing a distill run does, so that turns a finished run into an apparent hang
 * long after all the work is saved. Copying is a convenience, so a short bound is
 * the right trade: the block is already printed on screen either way.
 */
export const CLIPBOARD_TIMEOUT_MS = 5_000;

/** Copy text to the system clipboard. Reports which tool was used, or why not. */
export async function copyToClipboard(
  text: string,
  io: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    spawn?: ClipboardSpawn;
    timeoutMs?: number;
  } = {},
): Promise<{ ok: boolean; tool: string; error?: string }> {
  const { cmd, args } = clipboardCommand(io.platform, io.env);
  const spawn = io.spawn ?? defaultSpawn;
  const timeoutMs = io.timeoutMs ?? CLIPBOARD_TIMEOUT_MS;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ code: null; error: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ code: null, error: `${cmd} timed out after ${timeoutMs}ms` }),
      timeoutMs,
    );
    timer.unref?.(); // never hold the event loop open on our account
  });

  try {
    const result = await Promise.race([spawn(cmd, args, text), timeout]);
    if (result.code === 0) return { ok: true, tool: cmd };
    return {
      ok: false,
      tool: cmd,
      error: result.error ?? `${cmd} exited with code ${result.code}`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
