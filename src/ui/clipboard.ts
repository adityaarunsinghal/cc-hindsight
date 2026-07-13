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
    child.on("error", (err) => resolve({ code: null, error: err.message }));
    child.on("close", (code) => resolve({ code }));
    child.stdin?.write(input);
    child.stdin?.end();
  });

/** Copy text to the system clipboard. Reports which tool was used, or why not. */
export async function copyToClipboard(
  text: string,
  io: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; spawn?: ClipboardSpawn } = {},
): Promise<{ ok: boolean; tool: string; error?: string }> {
  const { cmd, args } = clipboardCommand(io.platform, io.env);
  const spawn = io.spawn ?? defaultSpawn;
  const result = await spawn(cmd, args, text);
  if (result.code === 0) return { ok: true, tool: cmd };
  return {
    ok: false,
    tool: cmd,
    error: result.error ?? `${cmd} exited with code ${result.code}`,
  };
}
