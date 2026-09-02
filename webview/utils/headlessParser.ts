/**
 * webview/utils/headlessParser.ts — the page's parser, built with no document
 * (MAR-430).
 *
 * Milkdown's `Editor.create()` cannot run where there is no DOM: its
 * `editorView` internal plugin reads `document.body` at the moment the editor
 * is PREPARED, before any plugin has run, so the failure is not in the view
 * being built but in the editor being constructed at all. Every other internal
 * plugin is DOM-free: the schema is `nodesCtx` and `marksCtx`, the parser is
 * the remark processor plus `ParserState`, and the editor state parses the
 * empty default document and never touches a view. So this runs the same
 * plugin pipeline the page runs, with the view plugin left out and the slices
 * it would have injected put in place, so a preset that records a view timer
 * or reads the root still registers and nothing ever waits on it.
 *
 * What a context has to provide is a global that is an EventTarget, because
 * Milkdown's clock resolves its timers by dispatching events on it. Every
 * window and every worker scope is one; Node's global is not, and the test
 * that builds this under Node says so where it shims it.
 *
 * The presets are the page's own objects (`format/markdown/parse.ts`), so
 * the parser this builds and the one the live editor holds are the same
 * pipeline twice, and `headlessParser.test.ts` holds them equal over the
 * corpus.
 */
import {
    Editor,
    commands,
    config,
    editorState,
    editorViewCtx,
    editorViewOptionsCtx,
    editorViewTimerCtx,
    init,
    keymap,
    parser,
    parserCtx,
    pasteRule,
    rootAttrsCtx,
    rootCtx,
    rootDOMCtx,
    schema,
    schemaCtx,
    serializer,
    serializerCtx,
} from "@milkdown/core";
import type { Node as ProseNode, Schema } from "./../pm";
import type { EditorCtx, FormatParse } from "../format/types";

/** A Milkdown plugin as the editor runs it: prepared with a ctx, then run. */
type MilkdownPlugin = (ctx: EditorCtx) => () => Promise<unknown>;

export interface HeadlessParser {
    /** The format's parser over its schema, as `parserCtx` gives it to the page. */
    parse(text: string): ProseNode | null;
    /** The format's serializer, the same object the page's `getMarkdown` reads. */
    serialize(doc: ProseNode): string;
    readonly schema: Schema;
    /** Run every plugin's cleanup, releasing the ctx's timers. */
    destroy(): Promise<void>;
}

export async function createHeadlessParser(format: FormatParse): Promise<HeadlessParser> {
    // `make()` constructs the container, the clock and the ctx and nothing
    // else; `create()` is what would reach for the document.
    const editor = Editor.make();
    const ctx = editor.ctx as unknown as EditorCtx;
    // What `editorView` would have injected. Nothing here waits on the view
    // timer; the slices exist so a preset's own registrations succeed.
    ctx.inject(rootCtx, null)
        .inject(editorViewCtx, {} as never)
        .inject(editorViewOptionsCtx, {})
        .inject(rootDOMCtx, null as never)
        .inject(rootAttrsCtx, {})
        .inject(editorViewTimerCtx, []);
    const configure = config((c) => {
        format.configureSerialization(c as EditorCtx);
    });
    const internal: MilkdownPlugin[] = [
        schema,
        parser,
        serializer,
        commands,
        keymap,
        pasteRule,
        editorState,
        init(editor),
        configure,
    ] as unknown as MilkdownPlugin[];
    const presets = (format.presets as unknown as unknown[]).flat(3) as MilkdownPlugin[];
    // Prepared in the editor's order (internal first, so the slices a preset
    // updates at prepare time exist), then run together: the clock orders
    // them, exactly as `Editor.create()` does.
    const internalHandlers = internal.map((plugin) => plugin(ctx));
    const presetHandlers = presets.map((plugin) => plugin(ctx));
    const [internalCleanups, presetCleanups] = await Promise.all([
        Promise.all(internalHandlers.map((run) => run())),
        Promise.all(presetHandlers.map((run) => run())),
    ]);
    const runAll = (cleanups: unknown[]): Promise<unknown[]> =>
        Promise.all(cleanups.map((cleanup) => (typeof cleanup === "function" ? (cleanup as () => unknown)() : undefined)));
    return {
        parse: (text) => ctx.get(parserCtx)(text) as ProseNode | null,
        serialize: (doc) => ctx.get(serializerCtx)(doc as never) as string,
        schema: ctx.get(schemaCtx) as Schema,
        async destroy() {
            // The presets first, then the internals, as `Editor.destroy()`
            // orders them: a preset's cleanup writes to slices the internals'
            // cleanups remove.
            await runAll(presetCleanups);
            await runAll(internalCleanups);
        },
    };
}
