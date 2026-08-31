import type { ProofreadConfig, ToolbarConfig, FontPreset, FontStacks } from "../../shared/messages";
import type { MermaidThemeMode } from "../../shared/mermaid";
import { PRODUCT_NAME } from "../../shared/product";

declare global {
    interface Window {
        __i18n?: {
            translations: Record<string, string>;
            isMac: boolean;
            /**
             * Open with edits locked (birta.readOnly). Read ONCE, at module
             * load, to seed webview/readOnly.ts — after that the mode's source
             * of truth is that module, because the toolbar toggle overrides the
             * setting for the session and a second copy here would go stale.
             */
            readOnly?: boolean;
            debugMode?: boolean;
            codeBlockAutoConvert?: boolean;
            /** Smart link resolution + wikilink autocomplete (birta.smartLinks). */
            smartLinks?: boolean;
            /**
             * Master network switch (birta.network.enabled), offline by default
             * (MAR-179). Gates EVERY network feature: nothing contacts the
             * network unless this is true. Mutated to true in-session when the
             * user accepts a just-in-time opt-in, so the feature works for the
             * rest of the session without a reload.
             */
            network?: boolean;
            /** Paste-unfurl: bare-URL paste fetches the page title (birta.pasteUnfurl.enabled). Also gated by `network`. */
            pasteUnfurl?: boolean;
            /** Apply a fetched title without asking, instead of offering it (birta.pasteUnfurl.autoApply). */
            pasteUnfurlAutoApply?: boolean;
            /** Link cards by default: a lone web link renders as an OG card (birta.linkCards.enabled). Also gated by `network`. */
            linkCardsEnabled?: boolean;
            /** Inline (unfenced) calc gate: the `=`/`=>` suggestions in prose (birta.calc.enabled). */
            calcEnabled?: boolean;
            /** Fenced ```calc block ledger gate (birta.calc.blocks.enabled); independent of `calcEnabled`. */
            calcBlocksEnabled?: boolean;
            /** Auto-insert the calc result on `=` instead of suggesting (birta.calc.autoInsert). */
            calcAutoInsert?: boolean;
            /** URL embeds: render a bare YouTube link as an inline facade card (birta.embeds.enabled). */
            embedsEnabled?: boolean;
            /**
             * Per-provider embed roster (birta.embeds.providers.<kind>), keyed
             * by EmbedKind. An absent entry means ON — read it through
             * embedProviderEnabled, never directly, so that rule has one home.
             */
            embedProviders?: Record<string, boolean>;
            /** Auto-update in-note `#slug` anchor links on heading rename (birta.autoUpdateAnchors). */
            autoUpdateAnchors?: boolean;
            /** Self-sinking checklists: checked items drop below unchecked (birta.checklist.sinkChecked). */
            checklistSinkChecked?: boolean;
            /**
             * Source line-number gutter (birta.lineNumbers), default OFF. Read
             * once at panel load to decide whether the gutter's module is
             * loaded at all; live changes arrive as `setLineNumbers`.
             */
            lineNumbers?: boolean;
            /** Extra literal markers surfaced in the Notes review tab (birta.notes.customMarkers). */
            notesCustomMarkers?: string[];
            /** Highlight note markers in the text (birta.notes.highlightMarkers); default on. */
            notesHighlightMarkers?: boolean;
            /** Review sidebar By-type/In-order mode (birta.review.groupByType); default grouped. */
            reviewGroupByType?: boolean;
            /**
             * The publishing targets whose syntax the editor OFFERS to write
             * (birta.syntax.sets). Read fresh on every gate check through
             * `enabledSyntaxSets()` rather than cached anywhere, and the live
             * `syntaxSetsChanged` message writes the new list back HERE, so
             * this stays the one copy. Absent means every target, which is what
             * keeps a page that says nothing (the unit tests, the e2e harness)
             * on the full toolbar.
             *
             * The list governs the tools and nothing else: the parser and the
             * serializer never read it, so a document renders whatever it
             * contains under every value. See shared/syntaxSets.ts.
             */
            syntaxSets?: readonly import("../../shared/syntaxSets").SyntaxSet[];
            codeBlockWordWrap?: boolean;
            tocAutoHideThreshold?: number;
            /** ToC show/hide preference (birta.tocVisibility); "auto" (or absent) uses the heading-count heuristic. */
            tocVisibility?: import("../../shared/messages").TocVisibility;
            /** Frontmatter panel expanded on open (birta.frontmatterExpanded). */
            frontmatterExpanded?: boolean;
            /** Add-metadata button on frontmatter-less documents (birta.frontmatterAddButton). */
            frontmatterAddButton?: boolean;
            /** Native-copy plain-text flavor: Markdown source (default) or the plain rendition (birta.copyFormat). */
            copyFormat?: "markdown" | "richText";
            /** Native-paste text flavor: parsed as Markdown (default) or inserted literally (birta.pasteFormat). */
            pasteFormat?: "markdown" | "plainText";
            proofread?: ProofreadConfig;
            /**
             * The Checks menu's answers by OPTION KEY, for a host that stores
             * what the reader changed rather than a whole config.
             *
             * A second shape for the same fact, and the split is deliberate:
             * `proofread` is a config a host computed, and this is the raw
             * key-value the page's own menu posted, handed straight back. A
             * shell that translated it would be holding a copy of the page's
             * vocabulary, which is exactly what went stale and switched this
             * feature off before. `initialConfig` does the translation, and
             * drops any key it does not recognise.
             */
            proofreadOptions?: Record<string, boolean>;
            /** Per-item toolbar placement config (see the toolbar registry). */
            toolbar?: ToolbarConfig;
            /**
             * Floating selection toolbar: master on/off + per-item visibility
             * (birta.floatingToolbar.enabled / .items.*). See the selection
             * toolbar registry.
             */
            floatingToolbar?: { enabled?: boolean; items?: Record<string, boolean> };
            /** Editor content font preset (drives the toolbar font picker). */
            /**
             * What the SURFACE is: capabilities, layout arrangements and the host's
             * own shortcuts, in one object (shared/hostProfile.ts). Everything else
             * in this blob is the USER'S settings, which is why the host's facts are
             * gathered under one key rather than scattered among them: one thing to
             * declare, one reader, one drift guard.
             */
            host?: Partial<import("../../shared/hostProfile").HostProfile>;
            fontPreset?: FontPreset;
            /** Effective per-preset font stacks (user overrides applied). */
            fontStacks?: FontStacks;
            /** Content font size as a percentage of the editor font size. */
            fontSize?: number;
            /** Content-width mode: full / fixed (birta.contentWidth). */
            contentWidth?: import("../../shared/contentWidth").ContentWidthMode;
            /** Fixed measure in ch, used when the mode is "fixed" (birta.maxContentWidth). */
            maxContentWidth?: number;
            /** Mermaid diagram theme mode: light / dark / auto (birta.mermaid.theme). */
            mermaidTheme?: MermaidThemeMode;
            /** PlantUML diagram theme mode: light / dark / auto (birta.plantuml.theme). */
            plantumlTheme?: import("../../shared/plantuml").PlantUmlThemeMode;
            /** Serialized document URI, used for context-menu command routing (MAR-9). */
            documentUri?: string;
            /**
             * Webview URI of the document's own directory, trailing slash
             * included: what a relative resource URL in rendered raw HTML
             * resolves against (utils/resourceUri.ts). Empty when the document
             * has no directory, which leaves resolution off.
             */
            resourceBaseUri?: string;
            /** The same, for the workspace root, which the `@/` alias names. */
            workspaceBaseUri?: string;
        };
    }
}

const _t: Record<string, string> = window.__i18n?.translations ?? {};
const _isMac: boolean = window.__i18n?.isMac ?? false;

/** Translate a string; if not found, return the original key (i.e. the English source text) */
export function t(key: string): string {
    return _t[key] ?? key;
}

/** The product name for UI that has to say it. See shared/product.ts. */
export const productName: string = PRODUCT_NAME;

/**
 * The order each platform prints modifiers in, and the two are NOT one list
 * reversed: `Mod` is a different key on each side. On a Mac it is Command,
 * which Apple puts last (⌃⌥⇧⌘). Everywhere else it IS Ctrl, which comes first
 * (Ctrl+Alt+Shift+K), so ranking it last there prints Alt+Shift+Ctrl.
 */
const MODIFIER_ORDER_MAC = ["Ctrl", "Alt", "Shift", "Mod"];
const MODIFIER_ORDER_OTHER = ["Mod", "Ctrl", "Alt", "Shift"];

/**
 * A chord's parts, with its modifier run put into the platform's order.
 *
 * Keymap notation carries no ordering semantics, so `Mod-Alt-1` and `Alt-Mod-1`
 * are one chord and the declaration cannot be the authority on how it reads.
 * Every other place this product prints a chord already uses the platform's
 * order: AppKit draws a menu item's key equivalent that way whatever order the
 * mask was built in, and `BirtaWriterCore/HotkeyCombo.swift` emits ⌃⌥⇧⌘ for the
 * summon hotkey. Left to the declaration, the Mac app's Format menu drew its
 * Heading 1 row as ⌥⌘1 while the tooltip on the same command read ⌘⌥1
 * (MAR-412).
 *
 * Anything that is not a modifier sorts last and keeps its relative position,
 * so a malformed chord degrades to the old output rather than being reordered
 * into nonsense.
 */
function inPlatformOrder(parts: string[]): string[] {
    const order = _isMac ? MODIFIER_ORDER_MAC : MODIFIER_ORDER_OTHER;
    // The final segment is the KEY, never a modifier, and it stays put: a chord
    // whose key is itself "Shift" or a hyphen must not be sorted into the run.
    const key = parts[parts.length - 1] ?? "";
    const rank = (p: string): number => {
        const i = order.indexOf(p);
        return i === -1 ? order.length : i;
    };
    const mods = parts.slice(0, -1).sort((a, b) => rank(a) - rank(b));
    return [...mods, key];
}

/**
 * Convert a shortcut string into the display format for the current platform.
 * The input format follows the ProseMirror keymap convention, e.g. 'Mod-b', 'Mod-Shift-z', 'Alt-k'.
 * Mac:  Mod→⌘  Ctrl→⌃  Shift→⇧  Alt→⌥  other characters uppercased, no separator
 * Win:  Mod→Ctrl  Shift→Shift  Alt→Alt  other characters uppercased, joined with '+'
 *
 * The separator is split the way prosemirror-keymap's own `normalizeKeyName`
 * splits it, on a hyphen that is not the last character. The notation uses the
 * hyphen for both jobs, so a chord whose KEY is a hyphen ("Mod--", the zoom-out
 * key every View menu binds) otherwise came apart into empty segments and
 * rendered as ⌘ with the key silently gone.
 *
 * Modifiers print in the PLATFORM's order rather than the order they were
 * declared in; `inPlatformOrder` above carries the argument for that.
 */

export function kbd(shortcut: string): string {
    const parts = inPlatformOrder(shortcut.split(/-(?!$)/));
    if (_isMac) {
        return parts
            .map((p) => {
                if (p === "Mod") {
                    return "⌘";
                }
                if (p === "Ctrl") {
                    return "⌃";
                }
                if (p === "Shift") {
                    return "⇧";
                }
                if (p === "Alt") {
                    return "⌥";
                }
                return p.toUpperCase();
            })
            .join("");
    } else {
        return parts
            .map((p) => {
                if (p === "Mod" || p === "Ctrl") {
                    return "Ctrl";
                }
                if (p === "Shift") {
                    return "Shift";
                }
                if (p === "Alt") {
                    return "Alt";
                }
                return p.toUpperCase();
            })
            .join("+");
    }
}
