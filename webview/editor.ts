import {
    defaultValueCtx,
    Editor,
    editorViewCtx,
    nodeViewCtx,
    rootCtx,
    serializerCtx,
} from "@milkdown/core";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { prism, prismConfig } from "@milkdown/plugin-prism";
import { gfm } from "@milkdown/preset-gfm";
import type { EditorView } from "@milkdown/prose/view";
import DOMPurify from "dompurify";
import { createCodeBlockView } from "./components/codeBlock";
import {
    createFootnoteDefinitionView,
    createFootnoteReferenceView,
} from "./components/footnote";
import { createImageView } from "./components/imageView";
import { createMathInlineView } from "./components/math";
import { createTableView } from "./components/table/tableView";
import { getMarkdown } from "@milkdown/utils";
import { refractor } from "./highlighter";
import { applyExternalSync } from "./externalSync";
import { configureSerialization, pureCommonmark } from "./serialization";
import {
    applyMinimalChanges,
    computeRoundTripProtection,
    type RoundTripProtection,
} from "./utils/minimalDiff";
import {
    caretScrollMarginPlugin,
    cellClickFixPlugin,
    codeBlockBackspacePlugin,
    codeBlockSelectAllPlugin,
    footnoteNumberingPlugin,
    footnoteReferenceInputRule,
    formatKeymapPlugin,
    headingEmptyDeletePlugin,
    headingFoldPlugin,
    headingStickyPlugin,
    historyKeymapPlugin,
    historyPlugin,
    horizontalRuleKeymapPlugin,
    horizontalRulePlugin,
    insertFootnoteCommand,
    linkInputRule,
    linkUrlCompletePlugin,
    listEnterPlugin,
    listLiftPlugin,
    listSpreadNormalizePlugin,
    proofreadPlugin,
    selectionPlugin,
    tabKeymapPlugin,
    tableKeymapPlugin,
    trailingHrParagraphPlugin,
} from "./plugins";

export { registerSelectionChangeHandler, setLogTableSel } from "./plugins";

// ── HTML inline NodeView ───────────────────────────────────────────────────
// Milkdown's html node (atom, inline) displays the raw tag as textContent by
// default. This NodeView renders real HTML after DOMPurify sanitization for a
// read-only preview. HTML comments would be sanitized away entirely — making
// them invisible and impossible to reason about in the editor — so they are
// rendered as a dimmed chip showing the raw comment text instead.
export function createHtmlView(node: { attrs: Record<string, string> }) {
    const dom = document.createElement("span");
    dom.dataset["type"] = "html";
    const raw = node.attrs["value"] ?? "";
    if (/^<!--[\s\S]*?-->$/.test(raw.trim())) {
        dom.className = "html-inline html-comment";
        dom.textContent = raw.trim();
        dom.title = "HTML comment — preserved in the file, hidden in rendered output";
    } else {
        dom.className = "html-inline";
        dom.innerHTML = DOMPurify.sanitize(raw, {
            USE_PROFILES: { html: true },
            ADD_ATTR: ["align", "width", "height"],
        });
    }
    return {
        dom,
        ignoreMutation: () => true,
        stopEvent: () => false,
    };
}

let _editor: Editor | null = null;

// The Markdown text as last saved/loaded (with the user's original
// formatting: blank lines, rule widths, ...). Used for the minimal-diff merge
// on autosave so a full re-serialization never reformats untouched regions.
let _savedMarkdown = '';

// Round-trip protection for the current file: change regions a ZERO-EDIT
// parse→serialize cycle produces on its own (dropped reference-link
// definitions, setext→ATX rewrites, escaping churn, ...). Computed once per
// createEditor() from the freshly loaded document; applyMinimalChanges pins
// these regions to their saved bytes so an edit elsewhere in the file can
// never silently destroy them. Constructs pasted AFTER load are not covered
// until the next reload — by then they are part of the saved baseline.
let _protection: RoundTripProtection | null = null;

// Whether the user has interacted with the editor yet (keyboard/mouse/paste/...)
// Reset to false on every createEditor() so that "just opening a file" never triggers an autosave.
let _hasUserInteracted = false;
let _interactionListenerAdded = false;

// IME composition state, hoisted to module scope so inbound external syncs can
// defer while the user is mid-composition (see syncExternalContent). The
// outbound save pipeline reads it too, so a pinyin/kana candidate is never sent
// to the file half-formed.
let _isComposing = false;
// Latest external content that arrived DURING composition, applied on
// compositionend. Only the most recent push matters — older ones are stale.
let _pendingExternalMarkdown: string | null = null;

function setupInteractionTracking(): void {
    if (_interactionListenerAdded) return;
    _interactionListenerAdded = true;
    const mark = () => { _hasUserInteracted = true; };
    document.addEventListener('keydown',   mark, { capture: true });
    document.addEventListener('mousedown', mark, { capture: true });
    document.addEventListener('paste',     mark, { capture: true });
    document.addEventListener('drop',      mark, { capture: true });
    document.addEventListener('cut',       mark, { capture: true });
}

export function getEditorView(): EditorView | null {
    if (!_editor) {
        return null;
    }
    return _editor.action((ctx) => ctx.get(editorViewCtx));
}

/**
 * Applies an inbound external document change as a cursor-preserving minimal
 * diff. Returns false when the caller must fall back to a full rebuild
 * (revert). While the user is mid-IME-composition the content is deferred and
 * applied on compositionend; a deferred call still returns true (handled, no
 * fallback).
 *
 * `newMarkdown` is DISPLAY-space content (image src already mapped to webview
 * URIs by the extension), matching the editor's own doc.
 */
export function syncExternalContent(newMarkdown: string): boolean {
    if (!_editor) {
        return false;
    }
    if (_isComposing) {
        _pendingExternalMarkdown = newMarkdown;
        return true;
    }
    return _applyExternalNow(newMarkdown);
}

/** Applies the external content now and re-baselines the save state. */
function _applyExternalNow(newMarkdown: string): boolean {
    if (!_editor) {
        return false;
    }
    if (!applyExternalSync(_editor, newMarkdown)) {
        return false;
    }
    // Re-baseline against the freshly applied content so the NEXT genuine user
    // edit diffs against the right bytes (and the debounced listener never
    // echoes the external change back to the extension as a save). Protection
    // is recomputed because a different file may have different round-trip
    // trouble spots (reference links, setext headings, ...).
    _savedMarkdown = newMarkdown;
    _protection = computeRoundTripProtection(
        newMarkdown,
        _editor.action(getMarkdown()),
    );
    return true;
}

export async function createEditor(
    container: HTMLElement,
    initialMarkdown: string,
    onUpdate: (markdown: string) => void,
    onRenameImage?: (webviewUri: string, newBasename: string) => Promise<void>,
): Promise<Editor> {
    // Milkdown's listener delivers updates asynchronously after create()
    // completes (RAF/microtask), by which point isSettled is already true and
    // a save would fire spuriously. _hasUserInteracted ensures content
    // updates are only sent to the Extension after real user input.
    _hasUserInteracted = false;
    setupInteractionTracking();

    let debounceTimer: ReturnType<typeof setTimeout>;
    // During IME composition (compositionstart → compositionend) stash the
    // latest markdown so a half-typed pinyin/kana candidate is never saved.
    _isComposing = false;
    _pendingExternalMarkdown = null;
    let pendingMd: string | null = null;

    const fireUpdate = (md: string) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => onUpdate(md), 300);
    };
    const debouncedUpdate = (md: string) => {
        if (_isComposing) {
            pendingMd = md; // composing: stash and send on compositionend
            return;
        }
        fireUpdate(md);
    };

    container.addEventListener('compositionstart', () => {
        _isComposing = true;
    });
    container.addEventListener('compositionend', () => {
        _isComposing = false;
        // Apply any inbound external sync that arrived mid-composition first, so
        // the file's authoritative state wins; a now-stale outbound save below
        // is harmless (the extension's version check drops and re-pushes it).
        if (_pendingExternalMarkdown !== null) {
            const md = _pendingExternalMarkdown;
            _pendingExternalMarkdown = null;
            _applyExternalNow(md);
        }
        if (pendingMd !== null) {
            const md = pendingMd;
            pendingMd = null;
            fireUpdate(md); // fire immediately after composition (still 300ms debounced)
        }
    });

    // Setting the initial content during editor.create() fires the update
    // listener; this flag blocks that initial trigger so opening a file never
    // causes a silent save.
    let isSettled = false;

    _editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, container);
            ctx.set(defaultValueCtx, initialMarkdown);
            // Stringify options that keep serializer output close to the
            // original file formatting (bullets, rules, table widths)
            configureSerialization(ctx);
            _savedMarkdown = initialMarkdown;
            // The `updated` hook (doc-based) is used instead of
            // `markdownUpdated`: plugin-listener captures the serializer from
            // serializerCtx ONCE at SerializerReady, so markdownUpdated would
            // race the fidelitySerializerPlugin swap and could serialize with
            // the stock serializer. Reading serializerCtx at call time always
            // uses the current (fidelity) serializer.
            ctx.get(listenerCtx).updated((innerCtx, doc) => {
                if (!isSettled) return;          // skip the synchronous trigger during init
                if (!_hasUserInteracted) return; // skip async init triggers (RAF/microtask delivery)
                const markdown = innerCtx.get(serializerCtx)(doc);
                const toSave = applyMinimalChanges(_savedMarkdown, markdown, _protection);
                if (toSave === _savedMarkdown) return; // no substantive change — no save
                _savedMarkdown = toSave;
                debouncedUpdate(toSave);
            });
            // Configure prism: use our refractor instance with the languages we registered
            ctx.set(prismConfig.key, {
                configureRefractor: () => refractor,
            });
            // Register the code_block NodeView (top language picker + copy button)
            ctx.set(nodeViewCtx, [
                ["code_block", createCodeBlockView],
                ["footnote_reference", createFootnoteReferenceView],
                ["footnote_definition", createFootnoteDefinitionView],
                ["math_inline", createMathInlineView],
                ["table", createTableView],
                ["html", (node: { attrs: Record<string, string> }) => createHtmlView(node)],
                [
                    "image",
                    (node, view, getPos) =>
                        createImageView(
                            node,
                            view,
                            getPos,
                            undefined,
                            undefined,
                            onRenameImage,
                        ),
                ],
            ]);
        })
        // Registered BEFORE the commonmark/base keymap so table Tab/Enter/Delete
        // win over the defaults (e.g. base Backspace only clears cell contents).
        .use(tableKeymapPlugin)
        .use(pureCommonmark)
        .use(gfm)
        .use(listener)
        .use(prism)
        .use(historyPlugin)
        .use(historyKeymapPlugin)
        .use(listLiftPlugin)
        .use(listEnterPlugin)
        .use(horizontalRulePlugin)
        .use(horizontalRuleKeymapPlugin)
        .use(codeBlockBackspacePlugin)
        .use(codeBlockSelectAllPlugin)
        .use(headingEmptyDeletePlugin)
        .use(selectionPlugin)
        .use(headingFoldPlugin)
        .use(headingStickyPlugin)
        .use(caretScrollMarginPlugin)
        .use(formatKeymapPlugin)
        .use(insertFootnoteCommand)
        .use(footnoteReferenceInputRule)
        .use(footnoteNumberingPlugin)
        .use(linkInputRule)
        .use(linkUrlCompletePlugin)
        .use(tabKeymapPlugin)
        .use(cellClickFixPlugin)
        .use(listSpreadNormalizePlugin)
        .use(trailingHrParagraphPlugin)
        .use(proofreadPlugin)
        .create();

    // Compare the loaded file against its own zero-edit serialization to
    // learn which regions the round trip cannot reproduce; those get pinned
    // to their saved bytes on every future save.
    _protection = computeRoundTripProtection(
        initialMarkdown,
        _editor.action(getMarkdown()),
    );

    isSettled = true;
    return _editor;
}
