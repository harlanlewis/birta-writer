import "./linkPopup.css";
import type { EditorView } from "@milkdown/prose/view";
import { notifyOpenUrl, notifyOpenFile } from "@/messaging";
import { scrollElementBelowTopbar } from "@/utils/headingUtils";
import {
    IconExternalLink,
    IconFileText,
    IconHash,
    IconLink,
    IconPencil,
    IconUnlink,
} from "@/ui/icons";
import { t } from "@/i18n";
import { applyTooltip } from "@/ui/tooltip";
import { slugify } from "@/utils/slug";
import { attachInputUndo } from "@/utils/inputUndo";
import {
    attachLinkTargetComplete,
    requestLinkTargetResolve,
} from "@/components/pathLink/linkTargetComplete";
import { createLinkFormatSwitch, wikiAllowedFor } from "@/ui/formatSwitch";
import { attrsFromRaw, wikiLinkId } from "@/plugins/wikiLinks";
import { setPendingRange } from "@/plugins/pendingRange";

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

let linkEditorHandle: ((opts: OpenLinkEditorOpts) => void) | null = null;

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
 * Find a heading element within the container by slug.
 * Prefer getElementById (when headingIds are assigned); on failure, fall back
 * to scanning all h1–h6 and matching by slug + duplicate count.
 * ProseMirror reconcile may strip the id attribute, so the fallback guarantees
 * the target is always found.
 */
function findHeadingElement(id: string, container: HTMLElement): HTMLElement | null {
    const direct = document.getElementById(id);
    if (direct) return direct;

    // Fallback: re-scan by slug (ProseMirror may have stripped the id attribute)
    const headings = container.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6");
    const counts = new Map<string, number>();
    for (const h of Array.from(headings)) {
        const base = slugify(h.textContent ?? "");
        if (!base) continue;
        const count = counts.get(base) ?? 0;
        const slug = count === 0 ? base : `${base}-${count}`;
        counts.set(base, count + 1);
        if (slug === id) return h;
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
        const el = findHeadingElement(id, container);
        return el ? (el.textContent?.trim() ?? null) : null;
    }

    function scrollToAnchor(id: string): void {
        const target = findHeadingElement(id, container);
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

    const btnOpen = document.createElement("button");
    btnOpen.className = "lp-btn lp-btn-open";
    btnOpen.innerHTML = IconExternalLink;
    const btnOpenTooltip = applyTooltip(btnOpen, openHint, { placement: "above" });

    const btnEdit = document.createElement("button");
    btnEdit.className = "lp-btn lp-btn-edit";
    btnEdit.innerHTML = IconPencil;
    applyTooltip(btnEdit, t("Edit link"), { placement: "above" });

    // Unlink (destructive but text-preserving): strips the link mark / replaces
    // a wikilink atom with its text. A link-level verb, so it lives in the
    // header beside Open/Edit — last, and visually separated (see CSS).
    const btnRemove = document.createElement("button");
    btnRemove.className = "lp-btn lp-btn-remove";
    btnRemove.title = t("Remove Link");
    btnRemove.innerHTML = IconUnlink;

    headerActions.appendChild(btnOpen);
    headerActions.appendChild(btnEdit);
    headerActions.appendChild(btnRemove);

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
    inputUrl.placeholder = t("URL https://...");

    // Format choice: standard markdown by default; an existing link opens on
    // its own format. Switching converts the link in place on apply.
    const formatSwitch = createLinkFormatSwitch("markdown", (format) => {
        // Resolution differs by format (bare wiki names match by filename).
        updateResolvedHint(inputUrl.value, format === "wikilink");
    });

    // No confirm button: edits apply on Enter and on input blur (the panel
    // stays open on blur, so a focus trip elsewhere never loses a change).
    body.appendChild(divider);
    body.appendChild(inputText);
    body.appendChild(inputUrl);
    body.appendChild(formatSwitch.el);

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
    // Whether a pending-range highlight is currently painted (so a close that
    // never entered edit mode never dispatches a needless clearing transaction).
    let pendingActive = false;
    // The last values applied to the document — blur/Enter apply only real
    // changes, never a no-op transaction per focus move.
    let lastApplied: { text: string; href: string; format: string } | null = null;
    // Stale-reply guard + debounce for the resolved-target hint.
    let resolveGeneration = 0;
    let resolveDebounce: ReturnType<typeof setTimeout> | null = null;

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
            requestAnimationFrame(() => inputText.focus());
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
            anchorHint.textContent = title ? `→ ${title}` : "";
            anchorHint.style.display = title ? "" : "none";
            btnOpenTooltip.setText(t("Jump to section"));
        } else {
            anchorHint.style.display = "none";
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

        updatePopupContent(link);

        // Position (viewport rect of the hovered anchor).
        popup.style.display = "flex";
        positionPopupAt(anchorEl.getBoundingClientRect());
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
        const popupH = popup.offsetHeight;
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;

        let top: number;
        if (spaceBelow >= popupH + 8 || spaceBelow >= spaceAbove) {
            top = rect.bottom + window.scrollY + 6;
        } else {
            top = rect.top + window.scrollY - popupH - 6;
        }

        let left = rect.left + window.scrollX;
        const popupW = popup.offsetWidth;
        if (left + popupW > window.innerWidth - 8) {
            left = window.innerWidth - popupW - 8;
        }
        if (left < 8) left = 8;

        popup.style.top = `${top}px`;
        popup.style.left = `${left}px`;
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
        btnEdit.style.display = "";
        // A brand-new link has nothing to unlink; cancel is Escape / click-away.
        btnRemove.style.display = "none";
        popup.style.display = "flex";

        updatePopupContent(currentLink);
        setEditMode(true); // expands the body, highlights the range, focuses text

        // A fresh insert has no target to open yet.
        const hasHref = currentLink.href.trim().length > 0;
        btnOpen.style.display = hasHref ? "" : "none";
        if (!hasHref) {
            urlEl.textContent = t("New link");
            urlEl.title = "";
        }

        positionPopupAt(opts.anchorRect);
    }

    function hidePopup(): void {
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
        popup.style.display = "none";
        currentLink = null;
        lastApplied = null;
        isEditMode = false;
        body.classList.remove("expanded");
        btnEdit.classList.remove("lp-btn-active");
    }

    function scheduleHide(delay = 180): void {
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

    // click capture: only handle anchor jumps (external/file links are handled in mousedown)
    container.addEventListener(
        "click",
        (e) => {
            const anchor = (e.target as Element).closest("a");
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
    function applyEdit(): void {
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

    document.addEventListener("mousedown", (e) => {
        if (!popup.contains(e.target as Node)) {
            // mousedown lands before the input's blur would — save first so
            // the click-away never eats an edit.
            applyEdit();
            hidePopup();
        }
    });

    // Expose the insert/edit entry point for the toolbar, Cmd/Ctrl+K, and the
    // slash menu (see openLinkEditor above).
    linkEditorHandle = openForInsert;
}
