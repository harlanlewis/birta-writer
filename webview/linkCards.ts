/**
 * webview/linkCards.ts
 *
 * The facts every surface of a LINK CARD shares (MAR-185): which paragraph
 * can be one, how it is named in the presentation store, and whether this
 * link is wanted as a card right now. A link card is the generic sibling of
 * a provider embed card: a web link that sits alone on its own line, shown
 * as a quiet card (title, description, site) read from the page's Open
 * Graph metadata. Render-only, like every embed: the file keeps the link.
 *
 * Kept a leaf (pm and blockWidth only) because both the embed plugin,
 * which draws the card, and the block menu, which offers the per-link
 * choice, need these answers, and the two must not import each other.
 *
 * The gate has three parts and reads at use time, so a settings flip needs
 * no reload (the embed plugin's regate re-runs the pass):
 *   1. `birta.network.enabled`: no network, no card, whatever was chosen; a
 *      card is a fetch and the master switch is the consent for fetches.
 *   2. The per-link choice (blockWidth `linkCardDisplay`), when the reader
 *      made one for this link.
 *   3. Otherwise `birta.linkCards.enabled`, the default, which ships off.
 */
import type { EditorView, Node as ProseNode } from "./pm";
import {
    anchorAt,
    getLinkCardDisplay,
    hasLinkCardDisplays,
    linkCardDisplayExistsFor,
    registerAnchorKind,
    type LinkCardDisplay,
} from "./blockWidth";

/**
 * The href of a paragraph that is exactly one web link and nothing else, or
 * null: a single text child carrying exactly one `link` mark whose href is
 * http(s). The text may be the URL itself (a bare autolink) or a label (a
 * pasted-and-unfurled `[title](url)`); both are one link on its own line,
 * which is what a card stands in for. Prose with a URL mid-sentence has
 * more than one child and fails here.
 */
export function soleLinkHref(node: ProseNode): string | null {
    if (node.type.name !== "paragraph" || node.childCount !== 1) {
        return null;
    }
    const child = node.firstChild;
    if (!child || !child.isText || !child.text) {
        return null;
    }
    const links = child.marks.filter((m) => m.type.name === "link");
    if (links.length !== 1) {
        return null;
    }
    const href = links[0]!.attrs["href"];
    return typeof href === "string" && /^https?:\/\//i.test(href) ? href : null;
}

export function linkCardAnchor(href: string): string {
    return `linkcard:${href}`;
}

/** The link-card anchor kind, on the paragraph (the node the card decorates). */
export const linkCardAnchorBase = registerAnchorKind("paragraph", (node) => {
    const href = soleLinkHref(node);
    return href === null ? null : linkCardAnchor(href);
});

/** The occurrence-disambiguated store key for the sole-link paragraph at
 * `pos`, or the bare anchor when the position cannot be resolved. */
export function linkCardAnchorAt(doc: ProseNode, pos: number | undefined, href: string): string {
    return anchorAt(doc, pos, linkCardAnchorBase) ?? linkCardAnchor(href);
}

function linkCardsDefaultOn(): boolean {
    return window.__i18n?.linkCardsEnabled ?? false;
}

function networkOn(): boolean {
    return window.__i18n?.network ?? false;
}

/** The reader's choice for this link, or the default when they made none. */
export function linkCardDisplayFor(anchor: string): LinkCardDisplay {
    return getLinkCardDisplay(anchor) ?? (linkCardsDefaultOn() ? "card" : "text");
}

/**
 * The reader's choice for the sole-link paragraph at `pos`, or null when
 * they made none for any occurrence of this link. Asked on the keystroke
 * path (the embed plugin's collect pass), so the occurrence anchor, whose
 * index is a document walk on a cache miss, is resolved only for a link
 * that carries a choice; a document with none never pays for it.
 */
function linkCardChoiceAt(doc: ProseNode, pos: number, href: string): LinkCardDisplay | null {
    if (!linkCardDisplayExistsFor(linkCardAnchor(href))) {
        return null;
    }
    return getLinkCardDisplay(linkCardAnchorAt(doc, pos, href));
}

/**
 * Whether the sole-link paragraph at `pos` renders as a card right now.
 * `explicitOnly` asks for the reader's own choice alone, ignoring the
 * default: the answer for a link a provider recognizes but whose provider
 * card is switched off, which the default must not quietly re-card.
 */
export function linkCardWanted(doc: ProseNode, pos: number, href: string, explicitOnly = false): boolean {
    if (!networkOn()) {
        return false;
    }
    const choice = linkCardChoiceAt(doc, pos, href);
    if (choice !== null) {
        return choice === "card";
    }
    return !explicitOnly && linkCardsDefaultOn();
}

/**
 * Whether the card pass has anything to look for: the default is on, or at
 * least one link carries a choice of its own. With neither, no document
 * walk happens for link cards at all (a disabled feature costs nothing).
 */
export function linkCardsPossible(): boolean {
    return networkOn() && (linkCardsDefaultOn() || hasLinkCardDisplays());
}

/** The site a card names: the host without a leading `www.`. */
export function linkCardSite(href: string): string {
    try {
        return new URL(href).hostname.replace(/^www\./, "");
    } catch {
        return href;
    }
}

// ── Repaint hook ────────────────────────────────────────────────────────────
// The card is drawn by the embed plugin, which the block menu must not import
// (the plugin imports the menu's delete primitive); the plugin registers its
// regate here and the menu calls it, the blockHandles late-binding precedent.
let _repaint: ((view: EditorView) => void) | null = null;

export function registerLinkCardRepaint(fn: (view: EditorView) => void): void {
    _repaint = fn;
}

/** Re-run the card pass after a per-link choice or a gate change. */
export function repaintLinkCards(view: EditorView): void {
    _repaint?.(view);
}
