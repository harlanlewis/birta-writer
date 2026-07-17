/**
 * webview/format/types.ts — the FormatModule seam (MAR-41).
 *
 * Everything the shared editor chrome consumes that is specific to ONE file
 * format, gathered behind a single injected object. This is the same move
 * `@birta/minimal-diff` made one layer down with its `FormatProfile`
 * (packages/minimal-diff bound to markdown in webview/utils/minimalDiff.ts),
 * applied at the editor level: the CHROME (editor shell, history, selection,
 * slash-menu shell, sync pipeline, toolbars) is format-agnostic and lives in
 * editor.ts / index.ts; the FORMAT (parsing presets, serializer
 * configuration, NodeViews, the minimal-diff profile) is supplied by a
 * module implementing this interface. Today the only implementation is
 * `format/markdown`; the multiformat track (MAR-40) adds more without
 * touching the chrome.
 *
 * Members exist only where the composition ACTUALLY varies by format — no
 * speculative hooks. Two consequences worth naming:
 *
 * - The presets fully define the serializer, INCLUDING any whole-document
 *   post-pass over its output. `createFidelitySerializerPlugin(postSerialize?)`
 *   (webview/plugins/fidelitySerializer.ts) is the injection point a format's
 *   preset uses; markdown binds the org-cookie unescape inside
 *   `pureCommonmark` (webview/serialization.ts). There is deliberately no
 *   separate post-pass member here — the preset is the single source of
 *   truth, so every construction site (production and tests) gets the pass
 *   by construction.
 * - The UI item registries (slash menu, main toolbar, selection toolbar) are
 *   consumed by their components directly from their registry homes
 *   (components/slashMenu/registry.ts etc.); no format varies them today, so
 *   they are not members. They join this interface when a format actually
 *   offers a different item set (MAR-40).
 *
 * (Naming note: `webview/components/linkPopup/formatSwitch.ts`'s `LinkFormat` is the
 * unrelated markdown-vs-wikilink LINK style toggle.)
 */
import type { Editor } from "@milkdown/core";
import type { NodeViewConstructor } from "../pm";
import type { FormatProfile } from "@birta/minimal-diff";

/** The ctx object Milkdown passes to `Editor.config()` callbacks. */
export type EditorCtx = Parameters<Parameters<Editor["config"]>[0]>[0];

/** What `Editor.use()` accepts: a single plugin or a plugin collection. */
export type EditorPlugins = Parameters<Editor["use"]>[0];

/** One `nodeViewCtx` registration: `[schema node name, NodeView factory]`. */
export type FormatNodeView = [nodeId: string, view: NodeViewConstructor];

/**
 * A file format the editor can host: the Milkdown presets that parse and
 * serialize it, the chrome registrations that render it, and the
 * minimal-diff profile that merges its serializations into saved bytes.
 */
export interface FormatModule {
    /**
     * The Milkdown plugin collections that define the format's schema,
     * parser, and serializer, in registration order (`.use()` is called once
     * per entry). Registered AFTER the chrome's pre-preset keymaps (which
     * must win over preset defaults) and BEFORE the rest of the chrome — see
     * the `.use()` chain in editor.ts.
     */
    readonly presets: ReadonlyArray<EditorPlugins>;

    /**
     * Apply the format's stringify configuration (options/handlers that keep
     * serializer output close to the original file formatting). Called from
     * the editor's `config()` block.
     */
    configureSerialization(ctx: EditorCtx): void;

    /**
     * The format's NodeView registrations for `nodeViewCtx` — the custom
     * renderers for the nodes its presets define. Every `nodeId` must exist
     * in the schema the presets build (pinned by formatModule.test.ts).
     */
    readonly nodeViews: ReadonlyArray<FormatNodeView>;

    /**
     * The `@birta/minimal-diff` profile for this format — the line
     * classifier/normalizers the save pipeline's minimal-diff merge and
     * round-trip protection run with (see webview/editor.ts syncNow /
     * getProtection).
     */
    readonly formatProfile: FormatProfile;
}
