/**
 * components/gotoLine/loader.ts
 *
 * The eager-graph seam for the Go to Line prompt: the prompt (`./index`, with
 * its stylesheet in `./styles`) loads through a cached dynamic `import()` the
 * first time the command runs, never at launch, the `shortcutsHelp/loader.ts`
 * pattern. The command host in `webview/index.ts` imports THIS module and
 * nothing from `./index`; a static import of `./index` on the launch path
 * puts the prompt back into the eager bundle, which `gotoLine.test.ts` pins.
 */
/** A line the prompt was given: 1-indexed document line, frontmatter included. */
export interface GotoLineTarget {
    line: number;
    /** 0-indexed column, when one was typed. */
    column?: number;
}

/**
 * What the prompt needs from the page, declared HERE rather than in `./index`
 * so the command host can name the type without a static import of the lazy
 * module (the eager-graph guard in `gotoLine.test.ts` walks imports as text,
 * type-only ones included). The target type is here for the same reason.
 */
export interface GotoLineHost {
    /** How many document lines there are, frontmatter included. */
    lineCount: () => number;
    /** The document line the caret is on, or null with no caret to speak of. */
    currentLine: () => number | null;
    /**
     * Scroll the document so `target` is on screen, and with `caret` put the
     * caret there too. Document lines, as the host's `scrollToLine` message
     * counts them.
     */
    reveal: (target: GotoLineTarget, caret: boolean) => void;
    /** Hand the keyboard back to the document. */
    focusEditor: () => void;
}

type GotoLineModule = typeof import("./index");

let modulePromise: Promise<GotoLineModule> | null = null;

/** Load (and cache) the prompt's module. */
export function loadGotoLine(): Promise<GotoLineModule> {
    return (modulePromise ??= import("./index"));
}

/**
 * Open the prompt. Resolves once it is on screen; a failed chunk load is
 * reported rather than thrown, so the command host can call this
 * fire-and-forget.
 */
export function openGotoLineLazy(host: GotoLineHost): Promise<void> {
    return loadGotoLine()
        .then((m) => m.openGotoLine(host))
        .catch((e: unknown) => console.error("[birta] go to line prompt failed to load", e));
}
