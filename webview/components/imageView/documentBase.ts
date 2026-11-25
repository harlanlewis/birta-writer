/**
 * Where a relative image path in the document is read from, for a host that
 * serves the document's folder rather than rewriting its paths.
 *
 * Two hosts, two answers to the same question. VS Code rewrites every image
 * path to a webview URI before the page sees the text and restores it on save
 * (`imageUriMap`), so a node's `src` is already absolute and nothing here
 * applies. The Mac app leaves the text alone and declares the note folder's
 * URL instead, so `../shared/a.png` means what it means on disk. A relative
 * `src` cannot simply be handed to the `<img>`: the page lives at the host's
 * own index URL, and resolving against that drops every `..` at the top.
 *
 * `scope` is the part of the URL space the host serves documents from. A path
 * that climbs out of it is refused here rather than requested, because URL
 * resolution clamps a climb at the origin's root and the request that would
 * reach the host no longer says it climbed.
 *
 * `@/` is the root alias the VS Code host already honours (its
 * `_prepareContentForDisplay`): a path from the top of the scope, which is the
 * opened folder in a rooted window and the note's own folder otherwise.
 *
 * Display only: the node's `src` stays exactly what the document says.
 */
import type { DocumentBase } from "../../../shared/messages";

let current: DocumentBase | null = null;
const listeners = new Set<() => void>();

/**
 * Set from `init`, and from a `documentBase` message when the host rebinds the
 * page to a file in another folder without reloading it. Null or absent means
 * paths are used as written. Listeners hear a change, not a repeat.
 */
export function setDocumentBase(base: DocumentBase | null | undefined): void {
    const next = base ?? null;
    if (next?.url === current?.url && next?.scope === current?.scope) { return; }
    current = next;
    for (const listener of [...listeners]) { listener(); }
}

/** Run `listener` whenever the base changes; returns the unsubscribe. */
export function onDocumentBaseChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** A `src` with a scheme, a leading slash, or a fragment is not relative. */
const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

/**
 * The URL to load for `src`, given a document base. Returns `src` unchanged
 * when there is no base or it is not a relative path, and "" when it climbs
 * out of the base's scope or does not parse, so the image shows as missing
 * rather than as whatever sits at the clamped path.
 */
export function resolveAgainstBase(src: string, base: DocumentBase | null): string {
    if (!base || !src) { return src; }
    const fromTop = src.startsWith("@/");
    if (!fromTop && NOT_RELATIVE.test(src)) { return src; }
    let resolved: URL;
    try {
        resolved = fromTop ? new URL(src.slice(2), base.scope) : new URL(src, base.url);
    } catch {
        return "";
    }
    return resolved.href.startsWith(base.scope) ? resolved.href : "";
}

/** `resolveAgainstBase` over the base `init` declared. */
export function imageDisplaySrc(src: string): string {
    return resolveAgainstBase(src, current);
}

/** Whether the host declared a base, so a typed path needs no resolve round-trip. */
export function hasDocumentBase(): boolean {
    return current !== null;
}
