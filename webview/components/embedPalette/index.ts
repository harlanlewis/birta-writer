/**
 * webview/components/embedPalette/index.ts
 *
 * The embed card's editor palette (MAR-187) — the image-toolbar contract
 * applied to URL embeds: selecting a card (click or arrow key) shows a small
 * anchored palette with the card's verbs, and the URL itself is an editable
 * field, never more than one glance away.
 *
 * Lifecycle is driven by the embed plugin's view observer (plugins/embed.ts
 * syncPalette): show while a card's paragraph is node-selected, hide
 * otherwise. This module is a lazy chunk beside the card builder — a document
 * with no embeds (or a user who never selects one) never loads it.
 *
 * Field semantics follow the house input contract (ui/dom.ts setupApplyOnBlur):
 * Enter applies, Escape reverts and closes, blur applies; commits are
 * idempotent. Applying rewrites the paragraph's text AND link mark in ONE
 * transaction (text must stay === href for the card trigger), with the
 * NodeSelection restored so the rebuilt card stays selected under the palette.
 */
import "./embedPalette.css";
import type { EditorView } from "@/pm";
import { NodeSelection, Selection } from "@/pm";
import { bindActivate, setupApplyOnBlur } from "@/ui/dom";
import { copyTextToClipboard } from "@/ui/clipboard";
import { notifyOpenUrl } from "@/messaging";
import { t } from "@/i18n";
import { applyTooltip } from "@/ui/tooltip";
import { attachInputUndo } from "@/utils/inputUndo";
import { registerEscapeLayer } from "@/ui/escapeLayers";
import { trackEditorReflow } from "@/ui/editorReflow";
import { computeAnchoredPosition, viewportSize } from "@/ui/anchoredPlacement";
import { IconCopy, IconExternalLink, IconTextInline, IconTrash2 } from "@/ui/icons";
import { deleteBlockRange } from "@/editing/blockOps";
import { readableUrl } from "@/utils/embedCard";
import type { EmbedKind } from "@/utils/embedProviders";
import { soleLinkHref } from "@/linkCards";

/** The selected embed the palette is editing, as the plugin reports it. */
export interface EmbedPaletteTarget {
    from: number;
    to: number;
    href: string;
    kind: EmbedKind | "linkCard";
    id: string;
    /** For a link card: "show as text link" records the reader's choice for
     * the link instead of rewriting it (a labelled link keeps its label). */
    asTextLink?: () => void;
}

let root: HTMLDivElement | null = null;
let urlInput: HTMLInputElement | null = null;
let copyTooltip: { setText: (text: string) => void } | null = null;
let copyRestoreTimer: ReturnType<typeof setTimeout> | null = null;

let currentView: EditorView | null = null;
let current: EmbedPaletteTarget | null = null;
let unregisterEscape: (() => void) | null = null;
let stopReflow: (() => void) | null = null;
/** The card whose identity strip the open palette is standing in for
 * (.embed-card--palette-open hides the strip under the palette). */
let markedCard: HTMLElement | null = null;
/** Escape dismissed the palette for this target; don't resurface until the
 * selection actually changes (`from:href` of the dismissed card). */
let dismissedKey: string | null = null;

const targetKey = (t_: EmbedPaletteTarget): string => `${t_.from}:${t_.href}`;

/** The view, guarded against a torn-down editor (linkPopup's liveView). */
function liveView(): EditorView | null {
    return currentView && currentView.dom.isConnected && !currentView.isDestroyed ? currentView : null;
}

/**
 * Re-verify the target against the live document before any edit: the palette
 * is a floating singleton and the doc may have changed under it. Returns the
 * paragraph node when it still starts at `from` with the expected bare link.
 */
function verifyTarget(view: EditorView): { from: number; to: number; labelled: boolean } | null {
    if (!current) { return null; }
    const node = view.state.doc.nodeAt(current.from);
    if (!node || node.type.name !== "paragraph") { return null; }
    // A provider card is a bare autolink (text is the href); a link card may
    // be labelled, so it verifies by the sole link's href instead.
    const href = soleLinkHref(node);
    if (href !== current.href) { return null; }
    if (current.kind !== "linkCard" && node.textContent !== current.href) { return null; }
    return { from: current.from, to: current.from + node.nodeSize, labelled: node.textContent !== current.href };
}

/** One-transaction rewrite of the link paragraph's content. */
function rewriteLink(view: EditorView, text: string, href: string, opts: { reselect: boolean }): void {
    const bounds = verifyTarget(view);
    if (!bounds) { return; }
    const linkType = view.state.schema.marks["link"];
    if (!linkType) { return; }
    const content = view.state.schema.text(text, [linkType.create({ href })]);
    let tr = view.state.tr.replaceWith(bounds.from + 1, bounds.to - 1, content);
    tr = opts.reselect
        ? tr.setSelection(NodeSelection.create(tr.doc, bounds.from))
        : tr.setSelection(Selection.near(tr.doc.resolve(bounds.from + 1 + text.length), -1));
    view.dispatch(tr.scrollIntoView());
}

function applyUrlEdit(): void {
    const view = liveView();
    if (!view || !current || !urlInput) { return; }
    const value = urlInput.value.trim();
    if (!value || value === current.href) { return; }
    let parsed: URL | null = null;
    try { parsed = new URL(value); } catch { /* not a URL */ }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        urlInput.value = current.href;
        return;
    }
    // A bare link stays bare (text === href: still a card if the new URL is
    // a recognized provider, an honest plain link if it isn't); a labelled
    // link card keeps its label and changes only where it points.
    const bounds = verifyTarget(view);
    if (!bounds) { return; }
    const label = bounds.labelled ? view.state.doc.nodeAt(bounds.from)?.textContent ?? value : value;
    rewriteLink(view, label, value, { reselect: true });
}

function build(): void {
    if (root) {
        // A torn-down document (editor reload, test teardown) can drop the
        // node while the module survives — re-attach rather than go dark.
        if (!root.isConnected) { document.body.appendChild(root); }
        return;
    }
    root = document.createElement("div");
    root.className = "embed-palette";
    root.addEventListener("mousedown", (e) => e.stopPropagation());

    urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "embed-palette__url";
    urlInput.spellcheck = false;
    urlInput.setAttribute("aria-label", t("Embed URL"));
    attachInputUndo(urlInput);
    setupApplyOnBlur(urlInput, {
        commit: applyUrlEdit,
        revert: () => { if (urlInput && current) { urlInput.value = current.href; } },
        onClose: () => liveView()?.focus(),
    });
    root.appendChild(urlInput);

    const makeButton = (icon: string, label: string, onActivate: () => void): HTMLButtonElement => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-btn ui-btn--icon embed-palette__btn";
        btn.innerHTML = icon;
        btn.setAttribute("aria-label", label);
        bindActivate(btn, onActivate);
        return btn;
    };

    const btnOpen = makeButton(IconExternalLink, t("Open externally"), () => {
        if (current) { notifyOpenUrl(current.href); }
    });
    applyTooltip(btnOpen, t("Open externally"), { placement: "above" });

    const btnCopy = makeButton(IconCopy, t("Copy link"), () => {
        if (!current) { return; }
        copyTextToClipboard(current.href);
        copyTooltip?.setText(t("Copied"));
        if (copyRestoreTimer) { clearTimeout(copyRestoreTimer); }
        copyRestoreTimer = setTimeout(() => {
            copyTooltip?.setText(t("Copy link"));
            copyRestoreTimer = null;
        }, 1000);
    });
    copyTooltip = applyTooltip(btnCopy, t("Copy link"), { placement: "above" });

    // Card ⇄ link conversion: a labeled [text](url) is deliberately never
    // carded, so giving the link a readable label IS "show as a link".
    const btnAsLink = makeButton(IconTextInline, t("Show as text link"), () => {
        const view = liveView();
        if (!view || !current) { return; }
        if (current.asTextLink) {
            current.asTextLink();
            hideEmbedPalette();
            return;
        }
        rewriteLink(view, readableUrl(current.href, 60), current.href, { reselect: false });
        view.focus();
    });
    applyTooltip(btnAsLink, t("Show as text link"), { placement: "above" });

    const btnDelete = makeButton(IconTrash2, t("Delete embed"), () => {
        const view = liveView();
        if (!view) { return; }
        const bounds = verifyTarget(view);
        if (bounds) { deleteBlockRange(view, bounds); }
        hideEmbedPalette();
    });
    btnDelete.classList.add("embed-palette__btn--danger");
    applyTooltip(btnDelete, t("Delete embed"), { placement: "above" });

    root.appendChild(btnOpen);
    root.appendChild(btnCopy);
    root.appendChild(btnAsLink);
    root.appendChild(btnDelete);
    document.body.appendChild(root);
}

/** Anchor to the card DOM (falling back to the paragraph host), linkPopup's
 * synchronous positioning discipline — a rAF-deferred read sees a moved page. */
function position(view: EditorView): void {
    if (!root || !current) { return; }
    const host = view.nodeDOM(current.from) as HTMLElement | null;
    // Anchor to the FRAME, not the whole card: the palette opens right below
    // it — exactly where the identity strip sits, which it replaces while open.
    const anchor = host?.querySelector(".embed-card__frame") ??
        host?.querySelector(".embed-card") ?? host;
    if (!anchor) { return; }
    const rect = (anchor as HTMLElement).getBoundingClientRect();
    // Measure and clamp in VIEWPORT coords, then convert to the document
    // coords this absolutely-positioned palette lives in. Adding scrollX to
    // `left` before the clamp mixed the two spaces in one rect and compared a
    // document-x against the viewport width.
    const placed = computeAnchoredPosition(
        { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        { width: root.offsetWidth, height: root.offsetHeight },
        viewportSize(),
    );
    root.style.top = `${placed.top + window.scrollY}px`;
    root.style.left = `${placed.left + window.scrollX}px`;
    // The reflow tracker re-runs this on every scroll, and the engine's clamps
    // are for a card that is PARTLY off: a card scrolled wholly out of view
    // would leave the palette pinned to a viewport edge over unrelated text.
    // Hidden, not closed: the card is still selected, and it comes back with
    // the card. `visibility` rather than `display`, so the palette keeps its
    // measured size and a focused URL field keeps focus.
    root.classList.toggle("embed-palette--offscreen", !placed.anchorInView);
}

/**
 * Show (or refresh) the palette for a selected card. Called on every editor
 * update while a card is selected — cheap when nothing changed. `focusUrl`
 * (Enter on the card) moves focus into the URL field; a plain show never
 * steals focus from the editor.
 */
export function showEmbedPalette(view: EditorView, target: EmbedPaletteTarget, focusUrl = false): void {
    if (!focusUrl && dismissedKey === targetKey(target)) { return; }
    build();
    if (!root || !urlInput) { return; }
    currentView = view;
    const changed = !current || current.from !== target.from || current.href !== target.href;
    current = target;
    const cardEl = (view.nodeDOM(target.from) as HTMLElement | null)
        ?.querySelector<HTMLElement>(".embed-card") ?? null;
    if (markedCard !== cardEl) {
        markedCard?.classList.remove("embed-card--palette-open");
        markedCard = cardEl;
    }
    cardEl?.classList.add("embed-card--palette-open");
    if (focusUrl) { dismissedKey = null; }
    if (changed && document.activeElement !== urlInput) {
        urlInput.value = target.href;
    }
    const wasVisible = root.classList.contains("embed-palette--visible");
    root.classList.add("embed-palette--visible");
    position(view);
    if (!wasVisible) {
        unregisterEscape = registerEscapeLayer(() => {
            // Escape dismisses the palette but keeps the card selected; don't
            // resurface it for this same selection on the next update tick.
            if (current) { dismissedKey = targetKey(current); }
            hideEmbedPalette(true);
            liveView()?.focus();
        });
        stopReflow = trackEditorReflow(view.dom, () => {
            const v = liveView();
            if (v) { position(v); }
        });
    }
    if (focusUrl) {
        urlInput.focus();
        urlInput.select();
    }
}

/**
 * Convert the bare-link paragraph at `from` to a labeled text link — the
 * never-carded form. The card's "show as text link" control and the palette's
 * button share this one implementation; one undo step, caret lands in the
 * converted paragraph.
 */
export function convertEmbedToTextLink(view: EditorView, from: number): void {
    const node = view.state.doc.nodeAt(from);
    if (!node || node.type.name !== "paragraph") { return; }
    const href = node.textContent;
    const linkType = view.state.schema.marks["link"];
    if (!linkType || !href) { return; }
    const content = view.state.schema.text(readableUrl(href, 60), [linkType.create({ href })]);
    let tr = view.state.tr.replaceWith(from + 1, from + node.nodeSize - 1, content);
    tr = tr.setSelection(Selection.near(tr.doc.resolve(from + 1), 1));
    view.dispatch(tr.scrollIntoView());
    view.focus();
}

/** Forget an Escape-dismissal: an explicit re-click on the card is the user
 * asking for the palette again, not the update loop resurfacing it. */
export function clearEmbedPaletteDismissal(): void {
    dismissedKey = null;
}

/** Is the palette currently visible for the embed at `from`? (The card's edit
 * control is a toggle — a second press must close what the first opened.) */
export function isEmbedPaletteOpenFor(from: number): boolean {
    return current?.from === from && !!root?.classList.contains("embed-palette--visible");
}

/** Hide and detach; `keepDismissed` preserves the Escape-dismissal marker. */
export function hideEmbedPalette(keepDismissed = false): void {
    if (!keepDismissed) { dismissedKey = null; }
    if (copyRestoreTimer) {
        clearTimeout(copyRestoreTimer);
        copyRestoreTimer = null;
        copyTooltip?.setText(t("Copy link"));
    }
    current = null;
    markedCard?.classList.remove("embed-card--palette-open");
    markedCard = null;
    unregisterEscape?.();
    unregisterEscape = null;
    stopReflow?.();
    stopReflow = null;
    root?.classList.remove("embed-palette--visible");
}
