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
 * speculative hooks. (Naming note: `webview/ui/formatSwitch.ts`'s
 * `LinkFormat` is the unrelated markdown-vs-wikilink LINK style toggle.)
 */
import type { Editor } from "@milkdown/core";
import type { NodeViewConstructor } from "@milkdown/prose/view";
import type { FormatProfile } from "@birta/minimal-diff";
import type { SlashMenuItem } from "../components/slashMenu/registry";
import type { ToolbarItemId } from "../components/toolbar/registry";
import type { FloatingToolbarItemId } from "../components/selectionToolbar/registry";

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

    /** The slash-menu item registry this format offers (re-exported from
     * components/slashMenu/registry.ts — the registry stays where it is). */
    readonly slashItems: ReadonlyArray<SlashMenuItem>;

    /** The main-toolbar item ids this format offers (re-exported from
     * components/toolbar/registry.ts). */
    readonly toolbarItems: ReadonlyArray<ToolbarItemId>;

    /** The floating selection-toolbar item ids this format offers
     * (re-exported from components/selectionToolbar/registry.ts). */
    readonly selectionToolbarItems: ReadonlyArray<FloatingToolbarItemId>;

    /**
     * The `@birta/minimal-diff` profile for this format — the line
     * classifier/normalizers the save pipeline's minimal-diff merge and
     * round-trip protection run with (see webview/editor.ts syncNow /
     * getProtection).
     */
    readonly formatProfile: FormatProfile;

    /**
     * Whole-document post-pass over the serializer's output — the one point
     * where the complete serialized string exists, for repairs that need
     * document-wide context. The format's serializer plugin applies it (see
     * `createFidelitySerializerPlugin`); markdown supplies the org-cookie
     * unescape (MAR-131). Omit when the format needs none.
     */
    readonly postSerialize?: (serialized: string) => string;
}
