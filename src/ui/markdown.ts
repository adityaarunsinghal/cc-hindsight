import { styleText } from "node:util";

/**
 * Apply ANSI styling, honoring THIS module's explicit `color` flag rather than
 * Node's stream auto-detection. `styleText`'s default path re-inspects
 * `process.stdout` and silently strips escapes whenever it looks non-color
 * (piped output, CI, the test runner) — which would override an explicit
 * `color: true` and make the flag a lie. `validateStream: false` disables that
 * re-check so the caller's decision is authoritative. Safe here because the
 * TTY-vs-pipe choice is made upstream (show.ts prints raw markdown when stdout
 * is not a TTY and never reaches this module with color on), and NO_COLOR is
 * likewise the caller's business — this module only styles when asked to.
 */
const sty = (format: Parameters<typeof styleText>[0], text: string): string =>
  styleText(format, text, { validateStream: false });

/**
 * ui/markdown.ts — zero-dependency ANSI rendering of the markdown subset that
 * authored oneshots (and exports) actually use: headings, **bold**, `inline
 * code`, fenced code blocks, bullet/numbered lists, paragraphs.
 *
 * Anything outside the subset stays literal — same fidelity philosophy as the
 * extractor: never mangle what we don't understand.
 *
 * Wrapping happens on visible characters BEFORE styling is applied (styled
 * words carry their kind through the wrap), so ANSI escape sequences can never
 * corrupt width math.
 */

export interface RenderOptions {
  /** Target text width (visible columns). */
  width?: number;
  /** Apply ANSI styling (disable for tests / non-TTY pipes). */
  color?: boolean;
}

type Kind = "plain" | "bold" | "code";
interface Fragment {
  text: string;
  kind: Kind;
}
/** One wrap unit; may span style boundaries (e.g. bold "probe" + plain ":"). */
interface Word {
  fragments: Fragment[];
  length: number;
}

/** Tokenize one line into styled words (code spans win over bold). */
function inlineWords(line: string): Word[] {
  const runs: Fragment[] = [];
  line.split("`").forEach((segment, i) => {
    if (i % 2 === 1) {
      if (segment.length > 0) runs.push({ text: segment, kind: "code" });
      return;
    }
    segment.split(/\*\*([^*]+)\*\*/).forEach((part, j) => {
      if (part.length > 0) runs.push({ text: part, kind: j % 2 === 1 ? "bold" : "plain" });
    });
  });

  // Merge run pieces into words: only whitespace separates words, so
  // punctuation glued to a styled span stays in the same wrap unit.
  const words: Word[] = [];
  let current: Fragment[] = [];
  const push = () => {
    if (current.length > 0) {
      words.push({
        fragments: current,
        length: current.reduce((n, f) => n + f.text.length, 0),
      });
      current = [];
    }
  };
  for (const run of runs) {
    for (const piece of run.text.split(/(\s+)/)) {
      if (piece.length === 0) continue;
      if (/^\s+$/.test(piece)) push();
      else current.push({ text: piece, kind: run.kind });
    }
  }
  push();
  return words;
}

function paint(word: Word, color: boolean): string {
  return word.fragments
    .map((f) => {
      if (!color || f.kind === "plain") return f.text;
      return f.kind === "bold" ? sty("bold", f.text) : sty("cyan", f.text);
    })
    .join("");
}

/** Greedy-wrap styled words to `width`, with a hanging indent for lists. */
function wrapWords(words: Word[], width: number, color: boolean, indent = "", hang = ""): string[] {
  const lines: string[] = [];
  let visible = indent.length;
  let current: string[] = [];
  let first = true;

  const flush = () => {
    if (current.length > 0) {
      lines.push((first ? indent : hang) + current.join(" "));
      first = false;
      current = [];
    }
  };

  for (const word of words) {
    if (current.length > 0 && visible + 1 + word.length > width) flush();
    if (current.length === 0) {
      visible = (first ? indent.length : hang.length) + word.length;
    } else {
      visible += 1 + word.length;
    }
    current.push(paint(word, color));
  }
  flush();
  return lines.length > 0 ? lines : [indent.trimEnd()];
}

/** Render markdown to ANSI-styled terminal text. */
export function renderMarkdownAnsi(markdown: string, opts: RenderOptions = {}): string {
  const width = opts.width ?? Math.max(30, Math.min(process.stdout.columns ?? 80, 100));
  const color = opts.color ?? true;
  const out: string[] = [];
  let paragraph: string[] = [];
  let fence: string[] | null = null;

  const blank = () => {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
  };
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(...wrapWords(inlineWords(paragraph.join(" ")), width, color));
      paragraph = [];
    }
  };

  for (const line of markdown.split("\n")) {
    if (fence) {
      if (line.trim().startsWith("```")) {
        for (const code of fence) {
          out.push(color ? sty("dim", `    ${code}`) : `    ${code}`);
        }
        blank();
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (line.trim().startsWith("```")) {
      flushParagraph();
      blank();
      fence = [];
      continue;
    }

    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading?.[1] !== undefined) {
      flushParagraph();
      blank();
      const text = heading[1].replace(/\*\*/g, "");
      out.push(color ? sty(["bold", "underline"], text) : text);
      blank();
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (bullet?.[1] !== undefined) {
      flushParagraph();
      out.push(...wrapWords(inlineWords(bullet[1]), width, color, "  • ", "    "));
      continue;
    }
    if (numbered?.[2] !== undefined) {
      flushParagraph();
      const n = `${numbered[1]}. `.padStart(5);
      out.push(...wrapWords(inlineWords(numbered[2]), width, color, n, " ".repeat(n.length)));
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      blank();
      continue;
    }
    paragraph.push(line.trim());
  }
  if (fence) {
    for (const code of fence) {
      out.push(color ? sty("dim", `    ${code}`) : `    ${code}`);
    }
  }
  flushParagraph();

  while (out[0] === "") out.shift();
  while (out[out.length - 1] === "") out.pop();
  return out.join("\n");
}
