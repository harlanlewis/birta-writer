/**
 * src/utils/logseqDetect.ts
 *
 * Answers one question: is this document part of a Logseq graph? The answer
 * gates Logseq-specific round-trip handling (MAR-131) and the toolbar's status
 * badge, and it must be cheap enough to run on every open.
 *
 * Two signals, in strict priority order:
 *
 *   1. The filesystem. A Logseq graph has a `logseq/config.edn`, or a sibling
 *      `pages/` + `journals/` pair, at its root. The document's ancestor
 *      directories are walked nearest-first (the same shape as
 *      linkResolver.ts's ancestor walk), so `graph/pages/Foo.md` finds
 *      `graph/`. This is the primary signal: it is about the file's place in a
 *      real graph rather than about anything the author typed.
 *
 *   2. The content, for a stray page opened outside its graph. This is a
 *      scored vote, never a single trigger, because every individual marker
 *      Logseq uses is also ordinary Markdown somewhere. A tab-indented bullet
 *      outline is just an outline; `{{...}}` is a Quarto/Hugo shortcode.
 *      Firing on one of those would claim an ordinary document, which is worse
 *      than not detecting at all: the round-trip handling it gates changes how
 *      bytes are written back.
 *
 * The scoring rule that falls out of that: at least one STRONG signal is
 * required, and weak signals only corroborate. Weak signals can never fire on
 * their own however many of them are present. `logseqDetect.test.ts` runs the
 * detector over every fixture in the tree and pins the count it claims.
 *
 * Pure by the linkResolver.ts precedent: no `vscode` import, the caller
 * injects the filesystem probes, so all of it is unit-testable.
 */
import * as path from "path";
// The enums live with the protocol (shared/messages.ts) rather than here: the
// webview types the same two values on the `logseqState` message, and a second
// declaration is a second thing to keep in step.
import type { LogseqMode, LogseqReason } from "../../shared/messages";

export interface LogseqIo {
    /** true iff absPath exists and is a directory */
    isDirectory(absPath: string): Promise<boolean>;
    /** true iff absPath exists and is a regular file */
    isFile(absPath: string): Promise<boolean>;
}

export interface LogseqContext {
    docFsPath: string;
    /** Workspace folder containing the doc, or null when there is none. */
    workspaceRootFsPath: string | null;
    /** The document's text. Already in memory at every call site; no IO. */
    text: string;
}

/**
 * How far up to walk when the document is outside any workspace folder. With a
 * workspace root the walk terminates there; without one it would otherwise
 * climb to the filesystem root, stat'ing every level. A graph root more than
 * this many levels above a page is not a shape Logseq produces.
 */
const MAX_UNROOTED_ANCESTORS = 8;

/** Ancestor dirs of `dir` up to and including `root` (nearest first). */
function ancestorsUpTo(dir: string, root: string): string[] {
    const out: string[] = [];
    let cur = dir;
    for (;;) {
        out.push(cur);
        if (cur === root) break;
        const parent = path.dirname(cur);
        if (parent === cur) break; // filesystem root; root wasn't an ancestor
        cur = parent;
    }
    return out;
}

/** Ancestor dirs of `dir`, nearest first, capped at `max` levels. */
function ancestorsCapped(dir: string, max: number): string[] {
    const out: string[] = [];
    let cur = dir;
    for (let i = 0; i < max; i++) {
        out.push(cur);
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }
    return out;
}

/**
 * Strong signals: vocabulary that belongs to Logseq and is close to absent
 * from ordinary Markdown. Any one of these is required before the content vote
 * can fire at all.
 */
const STRONG_SIGNALS: ReadonlyArray<readonly [string, (text: string) => boolean]> = [
    // A block reference: a full Logseq block UUID in double parens.
    ["blockRef", (t) => /\(\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)\)/i.test(t)],
    // Page or block properties: `key:: value`. The double colon is the tell.
    ["properties", (t) => /^[ \t]*[a-z][a-z0-9_-]*:: /m.test(t)],
    // A Logseq macro, matched by NAME. A bare `{{...}}` is not enough: Quarto,
    // Hugo and Jinja all spell shortcodes that way (fixtures/tools/quarto.md
    // fires on the bare form).
    ["macro", (t) => /\{\{\s*(query|embed|cloze|renderer|video|tweet|namespace|zotero)\b/i.test(t)],
    // An org-mode clock drawer, which Logseq writes for time-tracked tasks.
    ["logbook", (t) => /^[ \t]*:LOGBOOK:[ \t]*$/m.test(t)],
];

/**
 * Weak signals: true of Logseq pages and of plenty of ordinary documents.
 * They raise confidence in a page that already showed a strong signal and can
 * never establish one on their own.
 */
const WEAK_SIGNALS: ReadonlyArray<readonly [string, (text: string) => boolean]> = [
    // The outliner shape: every top-level line is a bullet. Property lines are
    // excluded because they legitimately precede the first bullet.
    ["allBullets", (t) => {
        const lines = t.split(/\r?\n/).filter((l) => l.trim() !== "");
        const top = lines.filter((l) => !/^[ \t]/.test(l) && !/^[a-z][a-z0-9_-]*:: /.test(l));
        return top.length >= 3 && top.every((l) => /^- /.test(l));
    }],
    // Tab-indented nesting, Logseq's default file format.
    ["tabIndent", (t) => /^\t+- /m.test(t)],
    // Logseq's task-state markers, at the head of a block.
    ["taskMarker", (t) => /^[ \t]*- (TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED|IN-PROGRESS)\b/m.test(t)],
];

const STRONG_WEIGHT = 2;
const WEAK_WEIGHT = 1;
/**
 * One strong signal alone scores 2, which is deliberately below this: a lone
 * `key:: value` line, or a lone `{{query}}`, is not enough to reclassify a
 * document. A strong signal plus any corroboration is.
 */
const CONTENT_THRESHOLD = 3;

/**
 * The content vote, exported for the fixture sweep in the tests. Returns the
 * score and the signals that fired, so a test can assert WHY rather than only
 * that the boolean came out right.
 */
export function scoreLogseqContent(text: string): {
    score: number;
    strong: string[];
    weak: string[];
    fired: boolean;
} {
    const strong = STRONG_SIGNALS.filter(([, test]) => test(text)).map(([name]) => name);
    const weak = WEAK_SIGNALS.filter(([, test]) => test(text)).map(([name]) => name);
    const score = strong.length * STRONG_WEIGHT + weak.length * WEAK_WEIGHT;
    return { score, strong, weak, fired: strong.length >= 1 && score >= CONTENT_THRESHOLD };
}

/**
 * Does `dir` look like the root of a Logseq graph? Either marker is
 * sufficient: `logseq/config.edn` is what Logseq itself writes, and the
 * `pages/` + `journals/` pair covers a graph whose config has been removed or
 * not yet created.
 */
async function isGraphRoot(dir: string, io: LogseqIo): Promise<boolean> {
    if (await io.isFile(path.join(dir, "logseq", "config.edn"))) return true;
    return (
        (await io.isDirectory(path.join(dir, "pages"))) &&
        (await io.isDirectory(path.join(dir, "journals")))
    );
}

/**
 * Resolves whether this document is handled as Logseq, and why.
 *
 * `off` returns immediately without touching `io` or reading the text, so the
 * default setting costs one comparison. That is the whole "a disabled feature
 * costs nothing" contract on the extension side (docs/DESIGN_PRINCIPLES.md);
 * callers are expected to skip the call entirely as well.
 */
export async function detectLogseq(
    mode: LogseqMode,
    ctx: LogseqContext,
    io: LogseqIo,
): Promise<LogseqReason | null> {
    if (mode === "off") return null;
    if (mode === "on") return "forced";

    const docDir = path.dirname(ctx.docFsPath);
    const root = ctx.workspaceRootFsPath;
    // A doc outside the workspace has no span between itself and the root, so
    // walking it against the root would escape upward; walk its own ancestors
    // under a cap instead (the same reasoning as linkResolver.ts's docInRoot).
    const docInRoot = root !== null && (docDir === root || docDir.startsWith(root + path.sep));
    const dirs = docInRoot
        ? ancestorsUpTo(docDir, root)
        : ancestorsCapped(docDir, MAX_UNROOTED_ANCESTORS);

    for (const dir of dirs) {
        if (await isGraphRoot(dir, io)) return "graph";
    }

    return scoreLogseqContent(ctx.text).fired ? "content" : null;
}
