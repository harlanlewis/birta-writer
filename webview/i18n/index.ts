import type { ProofreadConfig, ToolbarConfig, FontPreset, FontStacks } from "../../shared/messages";
import type { MermaidThemeMode } from "../../shared/mermaid";

declare global {
    interface Window {
        __i18n?: {
            translations: Record<string, string>;
            isMac: boolean;
            debugMode?: boolean;
            codeBlockAutoConvert?: boolean;
            /** Smart link resolution + wikilink autocomplete (birta.smartLinks). */
            smartLinks?: boolean;
            /** Paste-unfurl: bare-URL paste fetches the page title (birta.pasteUnfurl.enabled). */
            pasteUnfurl?: boolean;
            /** Inline calc-on-`=` master gate (birta.calc.enabled). */
            calcEnabled?: boolean;
            /** Auto-insert the calc result on `=` instead of suggesting (birta.calc.autoInsert). */
            calcAutoInsert?: boolean;
            /** URL embeds: render a bare YouTube link as an inline facade card (birta.embeds.enabled). */
            embedsEnabled?: boolean;
            /** Auto-update in-note `#slug` anchor links on heading rename (birta.autoUpdateAnchors). */
            autoUpdateAnchors?: boolean;
            /** Self-sinking checklists: checked items drop below unchecked (birta.checklist.sinkChecked). */
            checklistSinkChecked?: boolean;
            codeBlockWordWrap?: boolean;
            tocAutoHideThreshold?: number;
            /** Frontmatter panel expanded on open (birta.frontmatterExpanded). */
            frontmatterExpanded?: boolean;
            proofread?: ProofreadConfig;
            /** Per-item toolbar placement config (see the toolbar registry). */
            toolbar?: ToolbarConfig;
            /**
             * Floating selection toolbar: master on/off + per-item visibility
             * (birta.floatingToolbar.enabled / .items.*). See the selection
             * toolbar registry.
             */
            floatingToolbar?: { enabled?: boolean; items?: Record<string, boolean> };
            /** Editor content font preset (drives the toolbar font picker). */
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
            /** Serialized document URI, used for context-menu command routing (MAR-9). */
            documentUri?: string;
            /** The extension's display name (package.json), for UI that names the product. */
            productName?: string;
        };
    }
}

const _t: Record<string, string> = window.__i18n?.translations ?? {};
const _isMac: boolean = window.__i18n?.isMac ?? false;

/** Translate a string; if not found, return the original key (i.e. the English source text) */
export function t(key: string): string {
    return _t[key] ?? key;
}

/** The extension's display name (from package.json), or a safe fallback. */
export const productName: string = window.__i18n?.productName ?? "Birta Writer";

/**
 * Convert a shortcut string into the display format for the current platform.
 * The input format follows the ProseMirror keymap convention, e.g. 'Mod-b', 'Mod-Shift-z', 'Alt-k'.
 * Mac:  Mod→⌘  Shift→⇧  Alt→⌥  other characters uppercased, no separator
 * Win:  Mod→Ctrl  Shift→Shift  Alt→Alt  other characters uppercased, joined with '+'
 */
export function kbd(shortcut: string): string {
    const parts = shortcut.split("-");
    if (_isMac) {
        return parts
            .map((p) => {
                if (p === "Mod") {
                    return "⌘";
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
                if (p === "Mod") {
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
