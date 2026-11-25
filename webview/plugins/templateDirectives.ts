/**
 * webview/plugins/templateDirectives.ts — template directives drawn as source.
 *
 * A Hugo shortcode, a Liquid tag or a Jinja expression is text the editor
 * neither runs nor understands, and drawn as prose it reads as part of the
 * sentence beside it. This draws each one the way the editor draws other
 * source it leaves alone (an html tag chip): quiet monospace in the muted
 * description colour. A directive that is the whole of its line keeps that
 * line, because CommonMark joins a paragraph's lines with a space and a
 * paired shortcode around images would otherwise run into them.
 *
 * Decoration only, so the bytes cannot change: the document holds exactly
 * what it held and the serializer never sees this plugin. The recognizer
 * (utils/templateDirectives.ts) holds the grammar and the reasons for it,
 * code exclusion included.
 *
 * Always on, with no setting: this is how the editor draws a construct, like
 * a wikilink or a callout, rather than an opinion it volunteers about prose.
 *
 * Cost follows the viewport and the edit, never the document, and none of it
 * is on the mount path. This module is the eager shell; the recognizer, the
 * decoration building and the CSS are a lazy chunk
 * (plugins/templateDirectiveDecorations.ts) loaded by the first post-paint
 * idle pass. That pass covers the visible window (plugins/visibleRange.ts), a
 * window move rebuilds that window, and an edit redoes only the textblocks it
 * touched inside the window and maps the rest. With no layout engine the
 * window is null, which every pass reads as the whole document.
 */
import { $prose } from "@milkdown/utils";
import { DecorationSet, Plugin, PluginKey } from "../pm";
import type { EditorState } from "../pm";
import { requestIdle } from "../utils/idle";
import { PROGRESSIVE_APPEND_META } from "./docChange";
import { observeVisibleWindow, type VisibleWindow } from "./visibleRange";

type Builder = typeof import("./templateDirectiveDecorations");

const FIRST_PASS_IDLE_TIMEOUT_MS = 1000;

export interface TemplateDirectiveState {
    /** False until the first post-paint pass; nothing is built before it. */
    started: boolean;
    /** The window decorations cover; null means the whole document. */
    window: VisibleWindow | null;
    set: DecorationSet;
}

/** Exported for the tests, which read the live decoration set off it. */
export const templateDirectivesKey = new PluginKey<TemplateDirectiveState>("MDW_TEMPLATE_DIRECTIVES");

/** The lazy half, once loaded. Nothing starts before it is. */
let builder: Builder | null = null;
let loading: Promise<Builder> | null = null;

function loadBuilder(): Promise<Builder> {
    loading ??= import("./templateDirectiveDecorations").then(
        (m) => {
            m.ensureTemplateDirectiveStyles();
            builder = m;
            return m;
        },
        (error: unknown) => {
            // Let a later mount try again, and let the failure reach the
            // crash boundary as an unhandled rejection rather than vanish.
            loading = null;
            throw error;
        },
    );
    return loading;
}

export const templateDirectivesPlugin = $prose(
    () =>
        new Plugin<TemplateDirectiveState>({
            key: templateDirectivesKey,
            state: {
                init: () => ({ started: false, window: null, set: DecorationSet.empty }),
                apply(tr, value, _old, newState): TemplateDirectiveState {
                    const meta = tr.getMeta(templateDirectivesKey) as { window: VisibleWindow | null } | undefined;
                    if (meta && builder) {
                        return { started: true, window: meta.window, set: builder.buildDirectiveSet(newState.doc, meta.window) };
                    }
                    if (!tr.docChanged || !value.started || !builder) return value;
                    // A chunk of a progressive open lands exactly at the old
                    // end. The window must not grow over it, or the stream
                    // would decorate the whole document a chunk at a time; a
                    // chunk that arrives in view is the observer's to commit.
                    const appended = Boolean(tr.getMeta(PROGRESSIVE_APPEND_META));
                    const window = value.window && {
                        from: tr.mapping.map(value.window.from, -1),
                        to: tr.mapping.map(value.window.to, appended ? -1 : 1),
                    };
                    const set = builder.redoTouched(value.set.map(tr.mapping, tr.doc), tr, window);
                    return { started: true, window, set };
                },
            },
            props: {
                decorations(state: EditorState) {
                    return templateDirectivesKey.getState(state)?.set ?? DecorationSet.empty;
                },
            },
            view(view) {
                let disposed = false;
                let committed = false;
                const commit = (next: VisibleWindow | null): void => {
                    if (disposed || view.isDestroyed) return;
                    view.dispatch(
                        view.state.tr.setMeta(templateDirectivesKey, { window: next }).setMeta("addToHistory", false),
                    );
                };
                // Inert until start(), which runs after the post-paint idle
                // slot below, so not one decoration is drawn before first paint.
                const observer = observeVisibleWindow(view, (next) => {
                    committed = true;
                    commit(next);
                });
                const firstPass = requestIdle(() => {
                    if (disposed || view.isDestroyed) return;
                    void loadBuilder().then(() => {
                        if (disposed || view.isDestroyed) return;
                        observer.start();
                        // No window could be measured (no layout engine): the
                        // observer stays silent, so the pass covers the document.
                        if (!committed) commit(null);
                    });
                }, FIRST_PASS_IDLE_TIMEOUT_MS);
                return {
                    destroy() {
                        disposed = true;
                        firstPass.cancel();
                        observer.destroy();
                    },
                };
            },
        }),
);
