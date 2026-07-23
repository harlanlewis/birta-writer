import "./linkPopup.css";
import type { EditorView, Slice } from "@/pm";
import { notifyOpenUrl, notifyOpenFile } from "@/messaging";
import { collectDocHeadings, scrollElementBelowTopbar } from "@/utils/headingUtils";
import {
    IconCopy,
    IconExternalLink,
    IconFileText,
    IconFolderOpen,
    IconHash,
    IconLink,
    IconLinkOff,
    IconPencil,
} from "@/ui/icons";
import { t } from "@/i18n";
import { applyTooltip } from "@/ui/tooltip";
import { slugify, slugifyHeadings } from "@/utils/slug";
import { attachInputUndo } from "@/utils/inputUndo";
import {
    attachLinkTargetComplete,
    requestLinkTargetResolve,
    requestPickLinkTarget,
} from "@/components/pathLink/linkTargetComplete";
import { createLinkFormatSwitch, wikiAllowedFor } from "./formatSwitch";
import { onOutsideClick } from "@/ui/outsideClick";
import { attrsFromRaw, wikiLinkId } from "@/plugins/wikiLinks";
import { setPendingRange } from "@/plugins/pendingRange";
import { registerEscapeLayer } from "@/ui/escapeLayers";
import { trackEditorReflow } from "@/ui/editorReflow";
import { computeAnchoredPosition, viewportSize } from "@/ui/anchoredPlacement";

// ── Types ─────────────────────────────────────────────────────────────

/** Viewport rect of the target range (matches DOMRect's edges). */
export interface LinkEditorAnchorRect {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

/** Options for opening the popup as an insert/edit-link editor (see openLinkEditor). */
export interface OpenLinkEditorOpts {
    view: EditorView;
    anchorRect: LinkEditorAnchorRect;
    from: number;
    to: number;
    text: string;
    href: string;
    wiki?: boolean;
}

/**
 * Opens the single link editor (the hover popup) as an insert/edit surface,
 * anchored at `anchorRect`. Wired by setupLinkPopup below; a no-op until the
 * popup has been set up. This is the entry point the toolbar link button,
 * Cmd/Ctrl+K, and the slash menu all route through.
 */
export function openLinkEditor(opts: OpenLinkEditorOpts): void {
    linkEditorHandle?.(opts);
}

/**
 * Dismiss the link popup if it is open (a no-op otherwise). Used when a
 * higher-level surface takes over — e.g. opening the block (handle) menu, which
 * shifts the user from inline to block-level intent.
 */
export function closeLinkEditor(): void {
    linkEditorCloseHandle?.();
}

let linkEditorHandle: ((opts: OpenLinkEditorOpts) => void) | null = null;
let linkEditorCloseHandle: (() => void) | null = null;

interface LinkInfo {
    href: string;
    text: string;
    from: number;
    to: number;
    /** A reference link ([text][ref]): openable but not editable in the popup —
     * editing would apply a `link` mark and destroy the reference form. */
    readOnly?: boolean;
    /** A wikilink atom ([[target]]): opens through the host's wiki resolution
     * (filename match) instead of path resolution. */
    wiki?: boolean;
}

type LinkKind = "anchor" | "file" | "external";

// ── Helper functions ──────────────────────────────────────────────────

function getLinkKind(href: string): LinkKind {
    if (href.startsWith("#")) return "anchor";
    if (href.match(/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//)) return "external";
    return "file";
}

/**
 * Walk left/right from the anchor's position collecting the contiguous run
 * covered by `markName`, returning null when the mark isn't found (a stale DOM
 * anchor). Never falls back to paragraph bounds: an edit keyed off wrong bounds
 * would rewrite the whole paragraph as one link.
 */
function markBoundsAt(
    view: EditorView,
    anchor: Element,
    markName: string,
): { from: number; to: number } | null {
    let domPos: number;
    try {
        domPos = view.posAtDOM(anchor, 0);
    } catch {
        return null;
    }
    if (domPos < 0) return null;

    const { state } = view;
    const docSize = state.doc.content.size;
    const pos = Math.min(domPos, docSize - 1);
    const markType = state.schema.marks[markName];
    if (!markType) return null;

    let from = pos;
    let to = pos;
    const nodeAt = state.doc.nodeAt(pos);
    if (nodeAt && markType.isInSet(nodeAt.marks)) {
        while (from > 0) {
            const n = state.doc.nodeAt(from - 1);
            if (n && markType.isInSet(n.marks)) from--;
            else break;
        }
        while (to < docSize) {
            const n = state.doc.nodeAt(to);
            if (n && markType.isInSet(n.marks)) to++;
            else break;
        }
    }
    if (from === to) return null;
    return { from, to };
}

/**
 * Resolve a reference link's identifier to its `[label]: url` definition's URL,
 * scanning the document's `link_definition` nodes. Markdown identifiers are
 * normalized (case-insensitive), so compare case-folded. Returns null when no
 * definition (or an empty URL) is found — there is then nothing to open.
 */
export function resolveReferenceUrl(
    view: EditorView,
    identifier: string,
): string | null {
    const id = identifier.trim().toLowerCase();
    if (!id) return null;
    let url: string | null = null;
    view.state.doc.descendants((node) => {
        if (url !== null) return false;
        if (node.type.name === "link_definition") {
            const defId = String(node.attrs["identifier"] ?? "").trim().toLowerCase();
            if (defId === id) {
                const u = String(node.attrs["url"] ?? "");
                if (u) url = u;
                return false;
            }
        }
        return undefined;
    });
    return url;
}

/**
 * Bounds of the inline atom node rendered by `anchor` (wikilinks are nodes,
 * not marks, so markBoundsAt doesn't apply). posAtDOM may land at or just
 * after the atom depending on which DOM child was hit; try both.
 */
function nodeBoundsAt(
    view: EditorView,
    anchor: Element,
    nodeName: string,
): { from: number; to: number } | null {
    let domPos: number;
    try {
        domPos = view.posAtDOM(anchor, 0);
    } catch {
        return null;
    }
    if (domPos < 0) return null;
    const { state } = view;
    for (const pos of [domPos, domPos - 1]) {
        if (pos < 0) continue;
        const node = state.doc.nodeAt(pos);
        if (node && node.type.name === nodeName) {
            return { from: pos, to: pos + node.nodeSize };
        }
    }
    return null;
}

/** The href-equivalent a wikilink anchor routes with (see wikiLinks.ts). */
function wikiHrefOf(anchor: Element): string {
    const el = anchor as HTMLElement;
    const target = el.dataset["target"] ?? "";
    const heading = el.dataset["heading"] ?? "";
    if (!target) return heading ? `#${slugify(heading)}` : "";
    return heading ? `${target}#${heading}` : target;
}

function findLinkAt(view: EditorView, anchor: Element): LinkInfo | null {
    const text = anchor.textContent ?? "";

    // Wikilink atom: openable and editable through the format switch. The
    // same-page form ([[#heading]]) stays read-only — its target field would
    // show a derived slug, not anything the user wrote.
    if (anchor.getAttribute("data-type") === "wiki-link") {
        const href = wikiHrefOf(anchor);
        if (!href) return null;
        const bounds = nodeBoundsAt(view, anchor, "wiki_link");
        if (!bounds) return null;
        return {
            href,
            text,
            from: bounds.from,
            to: bounds.to,
            readOnly: href.startsWith("#"),
            wiki: true,
        };
    }

    // Reference link: resolve the URL from its definition and treat as read-only.
    if (anchor.getAttribute("data-type") === "link-ref") {
        const identifier = (anchor as HTMLElement).dataset["identifier"] ?? "";
        const url = resolveReferenceUrl(view, identifier);
        if (!url) return null;
        const bounds = markBoundsAt(view, anchor, "link_ref");
        if (!bounds) return null;
        return { href: url, text, from: bounds.from, to: bounds.to, readOnly: true };
    }

    const href = anchor.getAttribute("href") ?? "";
    const bounds = markBoundsAt(view, anchor, "link");
    if (!bounds) return null;
    return { href, text, from: bounds.from, to: bounds.to };
}

/**
 * Resolve an anchor slug `id` to its heading — from the DOC MODEL, never the
 * rendered DOM. This is what makes the section-link producer and this resolver
 * agree: the picker mints `#slug` via collectDocHeadings → slugifyHeadings (over
 * the model's `node.textContent`), so the resolver must slug the SAME text. A
 * heading carrying an inline atom (e.g. `## Cost $x^2$`) has clean model text
 * "Cost" but KaTeX-rendered garble in the DOM — a DOM-sourced slug would never
 * match the minted one, and the link would resolve to nothing.
 *
 * Returns the authoritative model title (headings[i].text) plus the heading's
 * live DOM element (via view.nodeDOM(pos), the inverse of findHeadingPos) for
 * scrolling. The element may be null (jsdom can't measure/mount every node) even
 * when the title resolves, so the hover title still works without a DOM hit.
 * Returns null when no heading slugifies to `id` — a dangling anchor.
 *
 * Deliberately NOT getElementById(id): a raw id lookup can hit non-heading
 * chrome that happens to share the id (a heading "TOC" slugifies to `toc`, which
 * a `#toc` panel element would wrongly satisfy), and it would reintroduce the
 * DOM-text slug mismatch above. Model resolution subsumes both.
 */
function resolveAnchorHeading(
    view: EditorView | null,
    id: string,
): { title: string; element: HTMLElement | null } | null {
    if (!view) return null;
    const headings = collectDocHeadings(view.state.doc);
    const slugs = slugifyHeadings(headings.map((h) => h.text));
    for (let i = 0; i < headings.length; i++) {
        if (slugs[i] !== id) continue;
        const dom = view.nodeDOM(headings[i].pos);
        return {
            title: headings[i].text,
            element: dom instanceof HTMLElement ? dom : null,
        };
    }
    return null;
}

// ── Main function ─────────────────────────────────────────────────────

export function setupLinkPopup(
    container: HTMLElement,
    getView: () => EditorView | null,
): void {
    const isMac = window.__i18n?.isMac ?? false;
    const openHint = isMac ? t("⌘ Click to open") : t("Ctrl+Click to open");

    function resolveAnchorTitle(id: string): string | null {
        // Model-sourced title: agrees with the minted slug even for headings
        // whose rendered DOM text differs from their model text (inline atoms).
        return resolveAnchorHeading(getView(), id)?.title ?? null;
    }

    function scrollToAnchor(id: string): void {
        const target = resolveAnchorHeading(getView(), id)?.element;
        if (!target) return;
        scrollElementBelowTopbar(target);
    }

    // ── Build the popup DOM ────────────────────────────────────────

    const popup = document.createElement("div");
    popup.className = "lp-root";
    popup.style.display = "none";
    document.body.appendChild(popup);

    // Header
    const header = document.createElement("div");
    header.className = "lp-header";

    const iconEl = document.createElement("span");
    iconEl.className = "lp-icon";

    const urlEl = document.createElement("span");
    urlEl.className = "lp-url";

    const headerActions = document.createElement("div");
    headerActions.className = "lp-header-actions";

    // Icon-only header buttons: applyTooltip strips the native title, so each
    // carries an explicit aria-label for its accessible name (screen readers).
    const btnOpen = document.createElement("button");
    btnOpen.className = "ui-btn ui-btn--icon lp-btn lp-btn-open";
    btnOpen.innerHTML = IconExternalLink;
    btnOpen.setAttribute("aria-label", t("Open link"));
    const btnOpenTooltip = applyTooltip(btnOpen, openHint, { placement: "above" });

    // Copy the link's href to the clipboard (Docs/Slack link-chip convention).
    const btnCopy = document.createElement("button");
    btnCopy.className = "ui-btn ui-btn--icon lp-btn lp-btn-copy";
    btnCopy.innerHTML = IconCopy;
    btnCopy.setAttribute("aria-label", t("Copy link"));
    const btnCopyTooltip = applyTooltip(btnCopy, t("Copy link"), { placement: "above" });

    // Unlink (destructive but text-preserving): strips the link mark / replaces
    // a wikilink atom with its text. A link-level verb, so it lives in the
    // header beside Open/Copy/Edit; its icon carries a slash so the "remove"
    // meaning is unambiguous, and only its hover uses the error color (see CSS).
    const btnRemove = document.createElement("button");
    btnRemove.className = "ui-btn ui-btn--icon lp-btn lp-btn-remove";
    btnRemove.setAttribute("aria-label", t("Remove Link"));
    btnRemove.innerHTML = IconLinkOff;
    applyTooltip(btnRemove, t("Remove Link"), { placement: "above" });

    const btnEdit = document.createElement("button");
    btnEdit.className = "ui-btn ui-btn--icon lp-btn lp-btn-edit";
    btnEdit.innerHTML = IconPencil;
    btnEdit.setAttribute("aria-label", t("Edit link"));
    applyTooltip(btnEdit, t("Edit link"), { placement: "above" });

    // Order: [open][copy][unlink][edit].
    headerActions.appendChild(btnOpen);
    headerActions.appendChild(btnCopy);
    headerActions.appendChild(btnRemove);
    headerActions.appendChild(btnEdit);

    header.appendChild(iconEl);
    header.appendChild(urlEl);
    header.appendChild(headerActions);

    // Anchor hint (has content only for anchor-type links)
    const anchorHint = document.createElement("div");
    anchorHint.className = "lp-anchor-hint";

    // Resolved-target hint: where the link actually opens, straight from the
    // host's openFile resolver. Rests under the header URL; while editing it
    // moves under the URL input and follows the typed value live.
    const resolvedHint = document.createElement("div");
    resolvedHint.className = "lp-resolved";
    resolvedHint.style.display = "none";

    // Body (edit mode, collapsed by default)
    const body = document.createElement("div");
    body.className = "lp-body";

    const divider = document.createElement("div");
    divider.className = "lp-divider";

    const inputText = document.createElement("input");
    inputText.type = "text";
    inputText.className = "lp-input lp-text-input";
    inputText.placeholder = t("Link text");

    const inputUrl = document.createElement("input");
    inputUrl.type = "text";
    inputUrl.className = "lp-input lp-url-input";
    inputUrl.placeholder = t("URL, path, or #heading");

    // OS-native file browser beside the URL field: complements the inline
    // path autocomplete for targets you'd rather find than type (deep trees,
    // non-markdown assets). The extension shows the dialog and replies with a
    // document-relative path; the field is filled but NOT committed — the
    // popup's apply-on-Enter/blur contract stays the single write path.
    const btnBrowse = document.createElement("button");
    btnBrowse.className = "ui-btn ui-btn--icon lp-btn lp-btn-browse";
    btnBrowse.innerHTML = IconFolderOpen;
    applyTooltip(btnBrowse, t("Browse files…"), { placement: "above" });
    // preventDefault keeps focus in the URL input (a focus trip to the button
    // is not a save point, and the dialog must not open on a half-blurred
    // field); the popup's outside-click handler never sees this (inside).
    btnBrowse.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    btnBrowse.addEventListener("click", () => {
        requestPickLinkTarget((picked) => {
            // The popup may have closed (Escape) or re-targeted while the
            // dialog waited on the user — a late reply must not resurrect it.
            if (picked === null || !isEditMode) { return; }
            inputUrl.value = picked;
            // Run the field's own input pipeline (resolved-target hint).
            inputUrl.dispatchEvent(new Event("input", { bubbles: true }));
            inputUrl.focus();
        });
    });

    const urlRow = document.createElement("div");
    urlRow.className = "lp-url-row";
    urlRow.appendChild(inputUrl);
    urlRow.appendChild(btnBrowse);

    // Format choice: standard markdown by default; an existing link opens on
    // its own format. Switching converts the link in place on apply.
    const formatSwitch = createLinkFormatSwitch("markdown", (format) => {
        // Resolution differs by format (bare wiki names match by filename).
        updateResolvedHint(inputUrl.value, format === "wikilink");
    });

    // No confirm button: edits apply on Enter and on input blur (the panel
    // stays open on blur, so a focus trip elsewhere never loses a change).
    // Field order follows the authoring flow: the target first (the URL/path is
    // the point of a link), then the local-link format that shapes it, then the
    // label the reader sees. Tab order follows this DOM order.
    body.appendChild(divider);
    body.appendChild(urlRow);
    body.appendChild(formatSwitch.el);
    body.appendChild(inputText);

    popup.appendChild(header);
    popup.appendChild(anchorHint);
    popup.appendChild(resolvedHint);
    popup.appendChild(body);

    // ── State ─────────────────────────────────────────────────────────

    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    let currentLink: LinkInfo | null = null;
    let isEditMode = false;
    // True while the popup was opened as an insert/edit editor (toolbar,
    // Cmd/Ctrl+K, slash menu) rather than by a hover — drives the pending-range
    // highlight lifecycle and the return-focus-to-editor on close.
    let insertMode = false;
    // True while the popup was opened by clicking a link (Google-Docs link-chip
    // behavior): it stays put on mouseleave and dismisses only on Escape or a
    // click outside both the popup and any link. A hover-opened popup is not
    // pinned and keeps its auto-hide.
    let pinned = false;
    // Whether a pending-range highlight is currently painted (so a close that
    // never entered edit mode never dispatches a needless clearing transaction).
    let pendingActive = false;
    // The last values applied to the document — blur/Enter apply only real
    // changes, never a no-op transaction per focus move.
    let lastApplied: { text: string; href: string; format: string } | null = null;
    // Live text preview: the link's pristine bytes before the first preview
    // transaction, so Escape (or any abandoning close) restores them exactly —
    // marks included. Non-null only while an uncommitted preview is in the
    // doc. Preview transactions carry addToHistory:false; the COMMIT reverts
    // silently first and then applies original→final as one normal
    // transaction, so undo sees exactly one step.
    let previewOriginal: { from: number; to: number; slice: Slice } | null = null;
    // Stale-reply guard + debounce for the resolved-target hint.
    let resolveGeneration = 0;
    let resolveDebounce: ReturnType<typeof setTimeout> | null = null;
    // Escape-layer unregister handle (null while hidden). Registered on both
    // open paths so an editor-focused Escape closes the popup (via blockKeys'
    // layer check) before any block-selection escalation.
    let escapeLayerOff: (() => void) | null = null;
    // Reflow-tracker unregister handle (null while hidden), plus a source for the
    // live anchor rect so the popup re-anchors to its target on scroll/reflow
    // instead of stranding where it first opened. Set on each open path.
    let reflowOff: (() => void) | null = null;
    let anchorRectSource: (() => LinkEditorAnchorRect | null) | null = null;

    function clearHoverTimer(): void {
        if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    }
    function clearHideTimer(): void {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    }

    function setEditMode(on: boolean): void {
        isEditMode = on;
        body.classList.toggle("expanded", on);
        btnEdit.classList.toggle("lp-btn-active", on);
        if (on) {
            // The hint follows the editing surface: appended after the fields.
            body.appendChild(resolvedHint);
            // Highlight the target range so it stays visibly marked while
            // focus lives in the popup's inputs (a caret insert has from===to,
            // which the plugin treats as "nothing to highlight").
            highlightPending();
            // Focus the URL first — it's the primary field and now leads the
            // form; the label is usually prefilled from the selection anyway.
            requestAnimationFrame(() => inputUrl.focus());
        } else {
            popup.insertBefore(resolvedHint, body);
            clearPending();
        }
    }

    /**
     * getView(), but only when its editor DOM is still connected. A torn-down
     * editing session (afterEach destroy in tests) leaves a stale singleton
     * whose view must never be dispatched to.
     */
    function liveView(): EditorView | null {
        const view = getView();
        return view && view.dom.isConnected ? view : null;
    }

    /** Paint the pending-range highlight over the current link's bounds. */
    function highlightPending(): void {
        if (!currentLink) { return; }
        const view = liveView();
        if (!view) { return; }
        setPendingRange(view, { from: currentLink.from, to: currentLink.to });
        pendingActive = true;
    }

    /** Clear the pending-range highlight (no-op when nothing is pending). */
    function clearPending(): void {
        if (!pendingActive) { return; }
        pendingActive = false;
        const view = liveView();
        if (view) { setPendingRange(view, null); }
    }

    /**
     * Shows where `pathText` opens right now (host resolver, no side
     * effects) — hidden for anchors and external URLs, "not found" styled
     * muted for a smart-mode miss.
     */
    function updateResolvedHint(pathText: string, wiki: boolean): void {
        const gen = ++resolveGeneration;
        const p = pathText.trim();
        const kind = p.startsWith("#") ? "anchor" : getLinkKind(p.split("#")[0] || "#");
        if (!p || kind !== "file") {
            resolvedHint.style.display = "none";
            resolvedHint.textContent = "";
            return;
        }
        requestLinkTargetResolve(p, wiki, (resolved) => {
            if (gen !== resolveGeneration || !currentLink) { return; }
            resolvedHint.textContent = resolved
                ? `→ ${resolved}`
                : t("not found in workspace");
            resolvedHint.classList.toggle("lp-resolved--miss", !resolved);
            resolvedHint.style.display = "";
        });
    }

    function updatePopupContent(link: LinkInfo): void {
        const kind = getLinkKind(link.href);

        // Icon
        if (kind === "anchor") {
            iconEl.innerHTML = IconHash;
        } else if (kind === "file") {
            iconEl.innerHTML = IconFileText;
        } else {
            iconEl.innerHTML = IconLink;
        }

        // URL display
        urlEl.textContent = link.href;
        urlEl.title = link.href;

        // Anchor hint + Open button tooltip
        if (kind === "anchor") {
            const id = link.href.slice(1);
            const title = resolveAnchorTitle(id);
            if (title) {
                anchorHint.textContent = `→ ${title}`;
                anchorHint.classList.remove("lp-anchor-hint--miss");
            } else {
                // Dangling same-document anchor: the slug resolves to no heading
                // (the target was deleted, or a rename outside this editor moved
                // it beyond auto-update's reach). A silent absence reads as "this
                // link is fine", so surface a quiet "not found" instead of the
                // former no-op — the design principle "a silent absence needs a
                // signal", matching the file link's "not found in workspace".
                anchorHint.textContent = t("Heading not found");
                anchorHint.classList.add("lp-anchor-hint--miss");
            }
            anchorHint.style.display = "";
            btnOpenTooltip.setText(t("Jump to section"));
        } else {
            anchorHint.style.display = "none";
            anchorHint.classList.remove("lp-anchor-hint--miss");
            btnOpenTooltip.setText(openHint);
        }

        // Pre-fill the edit fields. An existing wikilink's own format is
        // always allowed regardless of what its target looks like; and
        // lastApplied records the switch's SETTLED state (setWikiAllowed may
        // flip it), so the no-op guard can never see a phantom change and
        // rewrite an untouched link on a stray click.
        inputText.value = link.text;
        inputUrl.value = link.href;
        formatSwitch.set(link.wiki ? "wikilink" : "markdown");
        formatSwitch.setWikiAllowed(link.wiki ? true : wikiAllowedFor(link.href));
        lastApplied = {
            text: link.text,
            href: link.href,
            format: formatSwitch.get(),
        };
        updateResolvedHint(link.href, !!link.wiki);
    }

    function showPopup(link: LinkInfo, anchorEl: Element): void {
        clearHideTimer();
        currentLink = link;
        // Default to an unpinned (hover) popup; the click-to-pin path sets
        // `pinned` after this call. A hover over another link thus reverts a
        // previously pinned popup to normal auto-hide behavior.
        pinned = false;
        isEditMode = false;
        body.classList.remove("expanded");
        btnEdit.classList.remove("lp-btn-active");
        popup.insertBefore(resolvedHint, body);
        // Reference links are openable but not editable (editing would convert
        // them to inline links and destroy the reference form). Read-only links
        // (reference / same-page wiki) also can't be unlinked.
        btnEdit.style.display = link.readOnly ? "none" : "";
        btnRemove.style.display = link.readOnly ? "none" : "";
        btnOpen.style.display = ""; // reset from any prior insert open
        // Copy is available for any link with an href, read-only ones included.
        btnCopy.style.display = link.href.trim() ? "" : "none";
        btnCopyTooltip.setText(t("Copy link"));

        updatePopupContent(link);

        // Position (viewport rect of the hovered anchor). The anchor is the live
        // DOM node, so re-measuring it follows scroll/reflow.
        popup.style.display = "flex";
        escapeLayerOff ??= registerEscapeLayer(hidePopup);
        anchorRectSource = () => anchorEl.getBoundingClientRect();
        // Position from the live rect directly (non-null) rather than through
        // the nullable anchorRectSource field.
        positionPopupAt(anchorEl.getBoundingClientRect());
        startReflowTracking();
    }

    /** Viewport rect spanning a document range [from, to), or null if it can't
     *  be measured (a detached view). Used to re-anchor an insert/edit popup. */
    function rectFromRange(
        view: EditorView,
        from: number,
        to: number,
    ): LinkEditorAnchorRect | null {
        try {
            const start = view.coordsAtPos(from);
            const end = view.coordsAtPos(to, -1);
            return {
                left: Math.min(start.left, end.left),
                right: Math.max(start.right, end.right),
                top: Math.min(start.top, end.top),
                bottom: Math.max(start.bottom, end.bottom),
            };
        } catch {
            return null;
        }
    }

    /** Re-place the popup against its live anchor (called on scroll/reflow). */
    function repositionToAnchor(): void {
        const rect = anchorRectSource?.();
        if (rect) { positionPopupAt(rect); }
    }

    /** Begin following the editor's scroll/reflow for the current open popup. */
    function startReflowTracking(): void {
        if (reflowOff) { return; }
        const view = liveView();
        if (view) { reflowOff = trackEditorReflow(view.dom, repositionToAnchor); }
    }

    /**
     * Flip/clamp the popup against a viewport `rect`, keeping it on screen.
     * Shared by hover-show and insert-open; requires the popup already
     * displayed so its height/width can be measured.
     */
    function positionPopupAt(rect: LinkEditorAnchorRect): void {
        // Synchronous, not deferred to a frame: the insert path focuses an input
        // right after this, which scrolls an unplaced popup (sitting at the
        // bottom of the flow) into view — a later frame would then read the
        // bumped window.scrollY and place the popup far below its anchor. The
        // caller sets display:flex first, so offsetHeight is measurable now.
        // The popup is absolutely positioned in document coords: the anchor's
        // left carries scrollX into the clamp and scrollY is added to the
        // flip-decided top (flip/fit are viewport questions, so those use the
        // raw viewport rect).
        const placed = computeAnchoredPosition(
            { left: rect.left + window.scrollX, right: rect.right, top: rect.top, bottom: rect.bottom },
            { width: popup.offsetWidth, height: popup.offsetHeight },
            viewportSize(),
        );
        popup.style.top = `${placed.top + window.scrollY}px`;
        popup.style.left = `${placed.left}px`;
    }

    /**
     * Opens the popup as an insert/edit-link editor at `anchorRect`, in edit
     * mode with the fields prefilled. A caret open (from === to) has nothing
     * to open yet, so the header's open button is hidden and the URL shows a
     * neutral "New link" until a target is applied.
     */
    function openForInsert(opts: OpenLinkEditorOpts): void {
        clearHideTimer();
        clearHoverTimer();
        insertMode = true;
        currentLink = {
            from: opts.from,
            to: opts.to,
            text: opts.text,
            href: opts.href,
            wiki: opts.wiki || undefined,
            readOnly: false,
        };
        // In insert mode the link is already being edited: the header reads just
        // "[icon] New link", so hide the edit toggle. A brand-new link has
        // nothing to unlink either; cancel is Escape / click-away.
        btnEdit.style.display = "none";
        btnRemove.style.display = "none";
        popup.style.display = "flex";
        escapeLayerOff ??= registerEscapeLayer(hidePopup);

        updatePopupContent(currentLink);
        setEditMode(true); // expands the body, highlights the range, focuses text

        // A fresh insert has no target to open or copy yet.
        const hasHref = currentLink.href.trim().length > 0;
        btnOpen.style.display = hasHref ? "" : "none";
        btnCopy.style.display = hasHref ? "" : "none";
        if (!hasHref) {
            urlEl.textContent = t("New link");
            urlEl.title = "";
        }

        // Re-anchor to the live document range on scroll/reflow (the passed
        // anchorRect is a one-time measurement); fall back to it when the range
        // can't be measured.
        anchorRectSource = () => {
            const view = liveView();
            return view && currentLink
                ? rectFromRange(view, currentLink.from, currentLink.to) ?? opts.anchorRect
                : opts.anchorRect;
        };
        positionPopupAt(opts.anchorRect);
        startReflowTracking();
    }

    function hidePopup(): void {
        // An abandoning close (Escape, hover-out) with a live preview still in
        // the doc restores the original bytes. Committing paths (Enter,
        // blur, outside-click) run applyEdit first, which already consumed
        // the preview — this is a no-op there.
        revertPreview();
        // Every close path unregisters the Escape layer (idempotent).
        escapeLayerOff?.();
        escapeLayerOff = null;
        // Stop following scroll/reflow.
        reflowOff?.();
        reflowOff = null;
        anchorRectSource = null;
        clearHideTimer();
        clearHoverTimer();
        resolveGeneration++;
        if (resolveDebounce) { clearTimeout(resolveDebounce); resolveDebounce = null; }
        // Clear the pending-range highlight and, for an insert-opened editor,
        // hand focus back to the editor. Runs on every close path (Escape,
        // outside-click, blur, mouseleave) exactly once.
        clearPending();
        if (insertMode) { liveView()?.focus(); }
        insertMode = false;
        pinned = false;
        popup.style.display = "none";
        currentLink = null;
        lastApplied = null;
        isEditMode = false;
        body.classList.remove("expanded");
        btnEdit.classList.remove("lp-btn-active");
    }

    function scheduleHide(delay = 180): void {
        // A pinned popup never auto-hides — it dismisses only on Escape or a
        // click outside both the popup and any link.
        if (pinned) { return; }
        clearHideTimer();
        hideTimer = setTimeout(hidePopup, delay);
    }

    // ── Mouse hover: show the popup ──────────────────────────────

    container.addEventListener("mouseover", (e) => {
        const anchor = (e.target as Element).closest("a");
        if (!anchor) return;
        // Never retarget the popup while an edit is in progress — rebinding
        // would overwrite the fields and silently discard the unsaved edit
        // (blur/outside-click are the save points, not a passing pointer).
        if (isEditMode) return;

        clearHoverTimer();
        clearHideTimer();

        hoverTimer = setTimeout(() => {
            hoverTimer = null;
            const view = getView();
            if (!view) return;
            const link = findLinkAt(view, anchor);
            if (link) showPopup(link, anchor);
        }, 200);
    });

    container.addEventListener("mouseout", (e) => {
        if (!(e.target as Element).closest("a")) return;
        clearHoverTimer();
    });

    container.addEventListener("mouseleave", () => {
        clearHoverTimer();
        if (!popup.contains(document.activeElement)) {
            scheduleHide(200);
        }
    });

    popup.addEventListener("mouseenter", () => clearHideTimer());
    popup.addEventListener("mouseleave", () => {
        // A pinned popup stays put on mouseleave (Docs link-chip behavior).
        if (pinned) return;
        if (popup.contains(document.activeElement)) return;
        hidePopup();
    });

    // ── Link click (capture phase) ───────────────────────────────

    // mousedown capture: handle modifier+click (no preventDefault, to avoid the B086 focus issue)
    container.addEventListener(
        "mousedown",
        (e) => {
            const me = e as MouseEvent;
            if (!me.metaKey && !me.ctrlKey) return;
            const anchor = (me.target as Element).closest("a");
            if (!anchor) return;
            if (anchor.getAttribute("data-type") === "wiki-link") {
                const wikiHref = wikiHrefOf(anchor);
                if (!wikiHref || wikiHref.startsWith("#")) return; // same-page: click handler jumps
                e.stopPropagation();
                notifyOpenFile(wikiHref, { wiki: true });
                scheduleHide(50);
                return;
            }
            let href: string;
            if (anchor.getAttribute("data-type") === "link-ref") {
                // Resolve the reference's definition URL (link_ref carries no href).
                const view = getView();
                const resolved = view
                    ? resolveReferenceUrl(
                          view,
                          (anchor as HTMLElement).dataset["identifier"] ?? "",
                      )
                    : null;
                if (!resolved) return;
                href = resolved;
            } else {
                href = anchor.getAttribute("href") ?? "";
            }
            if (href.startsWith("#")) return; // anchors are handled by click
            e.stopPropagation();
            // Classify on the fragment-less form, but send the full href — the
            // host parses `file.md#27` line fragments, and external URLs keep
            // their anchors.
            if (getLinkKind(href.split("#")[0]) === "external") {
                notifyOpenUrl(href);
            } else {
                notifyOpenFile(href);
            }
            scheduleHide(50);
        },
        true,
    );

    // click capture: in-page anchors jump; a plain click on any other link
    // reveals and PINS its popup (Docs/Slack link-chip behavior). Modifier-open
    // is handled in mousedown above.
    container.addEventListener(
        "click",
        (e) => {
            const me = e as MouseEvent;
            const anchor = (me.target as Element).closest("a");
            if (!anchor) return;
            e.preventDefault();
            e.stopPropagation();

            const href =
                anchor.getAttribute("data-type") === "wiki-link"
                    ? wikiHrefOf(anchor)
                    : (anchor.getAttribute("href") ?? "");

            if (href.startsWith("#")) {
                // In-page anchor (incl. same-page [[#heading]]): jump directly,
                // no modifier key needed
                scrollToAnchor(href.slice(1));
                scheduleHide(50);
                return;
            }

            // Modifier-click opened the target already (mousedown); don't pin.
            if (me.metaKey || me.ctrlKey) return;
            // While an insert/edit editor is open, a click on a link is an
            // outside-click, not a re-point: apply the edit (blur already saved
            // it; this is idempotent) and close. Re-pointing here would discard
            // the fields; doing nothing (the old behavior) left the editor stuck
            // open, since the mousedown handler skips dismissal on link targets.
            if (isEditMode) { applyEdit(); hidePopup(); return; }

            // Plain click: show this link's popup, pinned so it stays put until
            // Escape or a click outside both the popup and any link. Clicking a
            // different link re-points the pinned popup to it.
            const view = getView();
            if (!view) return;
            const link = findLinkAt(view, anchor);
            if (link) {
                showPopup(link, anchor);
                pinned = true;
            }
        },
        true,
    );

    // ── Open button ───────────────────────────────────────────────

    function openCurrentLink(): void {
        if (!currentLink) return;
        const { href } = currentLink;
        if (href.startsWith("#")) {
            scrollToAnchor(href.slice(1));
        } else if (currentLink.wiki) {
            notifyOpenFile(href, { wiki: true });
        } else if (getLinkKind(href.split("#")[0]) === "external") {
            notifyOpenUrl(href);
        } else {
            notifyOpenFile(href);
        }
        hidePopup();
    }

    btnOpen.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCurrentLink();
    });

    // The URL text is itself a click target to open the link — not just the icon.
    urlEl.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCurrentLink();
    });

    // ── Copy button: href → clipboard ─────────────────────────────

    let copyRestoreTimer: ReturnType<typeof setTimeout> | null = null;

    /** Copy `text` to the clipboard; fall back to a hidden textarea + execCommand. */
    function copyToClipboard(text: string): void {
        navigator.clipboard?.writeText(text).catch(() => {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
            document.body.appendChild(ta);
            ta.focus(); ta.select();
            try { document.execCommand("copy"); } catch { /* ignore */ }
            document.body.removeChild(ta);
        });
    }

    btnCopy.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const href = currentLink?.href?.trim();
        if (!href) return;
        copyToClipboard(href);
        // Brief "Copied" feedback, then restore the tooltip.
        btnCopyTooltip.setText(t("Copied"));
        if (copyRestoreTimer) clearTimeout(copyRestoreTimer);
        copyRestoreTimer = setTimeout(() => {
            btnCopyTooltip.setText(t("Copy link"));
            copyRestoreTimer = null;
        }, 1000);
    });

    // ── Edit button: toggle edit mode ─────────────────────────────

    btnEdit.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setEditMode(!isEditMode);
    });

    // ── Applying edits (Enter and input blur — no confirm button) ─

    /**
     * Applies the edit fields to the document if anything actually changed.
     * Keeps `currentLink` coherent (bounds, values) so the editing session
     * can continue — blur saves without closing the panel.
     */
    /**
     * Live preview while typing in the text field: the on-page link text
     * follows the input, as an addToHistory:false transaction over the
     * pristine snapshot. Only for an EXISTING markdown link (an insert has
     * nothing on the page yet; a wiki atom re-renders wholesale on commit).
     *
     * Preview transactions DO flow down the save pipeline (docChange reports
     * every doc change; nothing upstream of the scheduler may filter) — that
     * is intentional, not leakage: the preview is the state the user
     * perceives, and AGENTS.md's sync invariant #2 says perceived state must
     * be save-capturable. Abandon and commit are symmetric through the same
     * pipeline (revertPreview also syncs, with a higher seq that supersedes
     * any in-flight preview update), so the persisted end state is always
     * the original (Escape) or the committed edit — a mid-preview autosave
     * is transient and self-healing. The one residual: hot exit DURING a
     * live preview persists the preview text, which is defensible for the
     * same reason (it was the visible state at the moment of exit).
     */
    function previewText(): void {
        const view = getView();
        if (!view || !currentLink || currentLink.readOnly || currentLink.wiki) { return; }
        // Caret inserts have nothing on the page to preview; a SELECTION does
        // (⌘K over selected text — the field is prefilled with it), so
        // insert-mode previews too whenever a real range is covered.
        if (currentLink.from === currentLink.to) { return; }
        const newText = inputText.value;
        // An empty field would leave a zero-width link — hold the preview and
        // let the commit rules decide (they treat empty text as "keep").
        if (!newText) { return; }
        const { state } = view;
        const linkType = state.schema.marks["link"];
        if (!linkType) { return; }
        const { from, to } = currentLink;
        previewOriginal ??= { from, to, slice: state.doc.slice(from, to) };
        if (newText === state.doc.textBetween(from, to)) { return; }
        const tr = state.tr.replaceWith(from, to, state.schema.text(newText));
        // Keep the existing link paint during preview; a not-yet-linked
        // selection (insert mode) has no href to re-add — plain text preview.
        if (currentLink.href) {
            tr.addMark(from, from + newText.length, linkType.create({ href: currentLink.href, title: null }));
        }
        tr.setMeta("addToHistory", false);
        view.dispatch(tr);
        currentLink = { ...currentLink, to: from + newText.length };
        // lastApplied is deliberately untouched: the commit must still see
        // "changed" and write the real history step.
    }

    /** Restore the pristine pre-preview bytes (marks included), silently. */
    function revertPreview(): void {
        if (!previewOriginal) { return; }
        const view = getView();
        const snapshot = previewOriginal;
        previewOriginal = null;
        if (!view || !currentLink) { return; }
        const tr = view.state.tr.replace(snapshot.from, currentLink.to, snapshot.slice);
        tr.setMeta("addToHistory", false);
        view.dispatch(tr);
        currentLink = { ...currentLink, to: snapshot.to };
    }

    function applyEdit(): void {
        // A live preview is scaffolding, not the edit: silently restore the
        // original first so the single history-visible transaction below is
        // original→final (one undo step, exactly as before previews existed).
        revertPreview();
        const view = getView();
        if (!view || !currentLink || currentLink.readOnly) { return; }

        const { state } = view;
        const linkType = state.schema.marks["link"];
        if (!linkType) { return; }

        const newHref = inputUrl.value.trim();
        const newText = inputText.value;
        const format = formatSwitch.get();
        if (
            lastApplied &&
            lastApplied.href === newHref &&
            lastApplied.text === newText &&
            lastApplied.format === format
        ) { return; }

        const { from, to } = currentLink;
        let tr = state.tr;
        let newTo = to;
        let isWiki = false;

        if (format === "wikilink") {
            // Wikilink form: URL field is the target(#heading), text field the
            // alias (omitted when empty or equal to the target). Replaces
            // either an existing wiki atom or a markdown link's text run —
            // an explicit edit, so rewriting this one link is correct.
            const wikiType = state.schema.nodes[wikiLinkId];
            if (!newHref || !wikiType) { return; }
            const raw =
                newText.trim() && newText.trim() !== newHref
                    ? `${newHref}|${newText.trim()}`
                    : newHref;
            // Bytes that can't live inside [[…]] would silently change the
            // document's structure on the next parse — refuse the apply.
            if (/\[\[|\]\]|[\r\n]/.test(raw)) { return; }
            tr = tr.replaceWith(from, to, wikiType.create(attrsFromRaw(raw)));
            newTo = from + 1; // inline atom
            isWiki = true;
        } else if (currentLink.wiki) {
            // Wiki → markdown conversion: the atom becomes linked text.
            const text = newText.trim() || newHref;
            if (!text) { return; }
            tr = tr.replaceWith(from, to, state.schema.text(text));
            if (newHref) {
                tr = tr.addMark(
                    from,
                    from + text.length,
                    linkType.create({ href: newHref, title: null }),
                );
            }
            newTo = from + text.length;
        } else if (from === to) {
            // Markdown insert at a caret: new linked text (the text field, or
            // the URL itself when no text was given) inserted at `from`.
            const insertText = newText || newHref;
            if (!insertText) { return; }
            tr = tr.replaceWith(from, to, state.schema.text(insertText));
            if (newHref) {
                tr = tr.addMark(
                    from,
                    from + insertText.length,
                    linkType.create({ href: newHref, title: null }),
                );
            }
            newTo = from + insertText.length;
        } else if (newText && newText !== currentLink.text) {
            tr = tr.replaceWith(from, to, state.schema.text(newText));
            if (newHref) {
                tr = tr.addMark(
                    from,
                    from + newText.length,
                    linkType.create({ href: newHref, title: null }),
                );
            }
            newTo = from + newText.length;
        } else {
            tr = tr.removeMark(from, to, linkType);
            if (newHref) {
                tr = tr.addMark(
                    from,
                    to,
                    linkType.create({ href: newHref, title: null }),
                );
            }
        }

        view.dispatch(tr);

        // The link just changed under the popup: keep the session coherent.
        currentLink = {
            ...currentLink,
            href: newHref || currentLink.href,
            text: newText || currentLink.text,
            to: newTo,
            wiki: isWiki || undefined,
        };
        lastApplied = { text: newText, href: newHref, format };
        urlEl.textContent = currentLink.href;
        urlEl.title = currentLink.href;
    }

    // ── Remove button ─────────────────────────────────────────────

    btnRemove.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const view = getView();
        if (!view || !currentLink) { hidePopup(); return; }
        if (currentLink.readOnly) { hidePopup(); return; }

        const { state } = view;
        const linkType = state.schema.marks["link"];
        if (!linkType) { hidePopup(); return; }

        if (currentLink.wiki) {
            // Removing a wikilink leaves its display text as plain prose.
            view.dispatch(
                state.tr.replaceWith(
                    currentLink.from,
                    currentLink.to,
                    state.schema.text(currentLink.text || " "),
                ),
            );
        } else {
            view.dispatch(state.tr.removeMark(currentLink.from, currentLink.to, linkType));
        }
        view.focus();
        hidePopup();
    });

    // ── Input helpers ─────────────────────────────────────────────

    // Workspace file autocompletion on the URL field (local link targets).
    // Attached before the keydown handler below, but order does not matter:
    // it listens in the capture phase and only intercepts keys while its
    // dropdown is open.
    attachLinkTargetComplete(inputUrl);

    // The wikilink option follows the URL live: an external target (scheme,
    // #anchor) can never be a wikilink. The resolved-target hint follows the
    // typed value on the input-field debounce cadence.
    inputUrl.addEventListener("input", () => {
        formatSwitch.setWikiAllowed(wikiAllowedFor(inputUrl.value));
        if (resolveDebounce) { clearTimeout(resolveDebounce); }
        resolveDebounce = setTimeout(() => {
            resolveDebounce = null;
            updateResolvedHint(inputUrl.value, formatSwitch.get() === "wikilink");
        }, 200);
    });

    // Live preview: the on-page link text follows the field while typing;
    // Escape (any abandoning close) restores the original, commit keeps it.
    inputText.addEventListener("input", () => previewText());

    [inputText, inputUrl].forEach((inp) => {
        // Local undo/redo: VS Code intercepts Cmd+Z before native inputs see it
        attachInputUndo(inp);
        inp.addEventListener("mousedown", (e) => e.stopPropagation());
        inp.addEventListener("keydown", (e) => {
            if (e.isComposing) return;
            if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                applyEdit();
                hidePopup();
                getView()?.focus();
            } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                hidePopup();
                getView()?.focus();
            }
        });
        // Blur SAVES instead of closing: a focus trip elsewhere commits the
        // edit and the panel stays until a normal close (outside click,
        // mouseleave, Escape). Moves within the panel are not a save point.
        inp.addEventListener("blur", (e) => {
            const next = (e as FocusEvent).relatedTarget as Node | null;
            if (next && popup.contains(next)) { return; }
            applyEdit();
        });
    });

    // ── Click outside the popup to close it ──────────────────────

    // Bubble phase (`capture: false`), matching the hand-rolled original: an
    // outside surface that stops its own mousedown propagation keeps the
    // popup open. Attached for the editor's lifetime, never detached.
    onOutsideClick(
        [popup],
        (e) => {
            const target = e.target as Element | null;
            // A mousedown on a link anchor is a click-to-pin (or a re-point to a
            // different link): let the capture-phase click handler re-anchor the
            // popup instead of dismissing it here. When an editor is open, that same
            // click handler applies-and-closes instead of re-pointing (see the
            // isEditMode branch there), so an outside-click on a link is never a
            // dead-end.
            if (target?.closest?.("a")) return;
            // mousedown lands before the input's blur would — save first so the
            // click-away never eats an edit.
            applyEdit();
            hidePopup();
        },
        { capture: false },
    );

    // Fallback: Escape closes an open (esp. pinned) popup when focus is
    // neither in the edit inputs (they handle Escape themselves and refocus
    // the editor) nor in editor content (there the Escape-layer stack closes
    // it via blockKeys, which preventDefaults — honored below so one Escape
    // never closes two surfaces). stopPropagation keeps the consumed chord
    // from the workbench key forwarder, matching the other overlays.
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (e.defaultPrevented) return; // a layer above already claimed it
        if (popup.style.display === "none") return;
        if (popup.contains(document.activeElement)) return;
        e.stopPropagation();
        hidePopup();
        getView()?.focus();
    });

    // Expose the insert/edit entry point for the toolbar, Cmd/Ctrl+K, and the
    // slash menu (see openLinkEditor above), plus a close handle for surfaces
    // that supersede the popup (see closeLinkEditor).
    linkEditorHandle = openForInsert;
    linkEditorCloseHandle = hidePopup;
}
