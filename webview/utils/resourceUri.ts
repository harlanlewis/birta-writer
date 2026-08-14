/**
 * Resolve a relative resource URL written in RENDERED HTML.
 *
 * A Markdown image arrives with its `src` already rewritten to a webview URI by
 * the extension. Raw HTML does not: its bytes reach the file exactly as typed,
 * which is the whole promise of the html node, so `<img src="images/cat.png">`
 * is rendered from the authored path and resolves against the webview's own
 * origin rather than the document's directory. Resolution therefore belongs
 * here, on the rendered output, where the document's bytes are untouched and
 * the source panel still shows the user the path they wrote.
 *
 * The bases come from `window.__i18n` (src/webviewHtml.ts, getResourceBaseUris)
 * and both end in `/`. With neither set, every URL is left as authored: that is
 * the untitled and non-`file` document, which has no directory to resolve
 * against.
 */

/** Anything with a scheme, or protocol-relative: already absolute, leave it. */
const ABSOLUTE_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
/** The workspace-root alias, the same one a Markdown image path may use. */
const WORKSPACE_ALIAS = "@/";

/** Attributes holding ONE url. `srcset` holds a list and is handled separately. */
const URL_ATTRS = ["src", "poster"] as const;
const URL_SELECTOR = URL_ATTRS.map((attr) => `[${attr}]`).join(",");
const SRCSET_SELECTOR = "[srcset]";

function baseFor(url: string): string {
    const i18n = window.__i18n;
    return (url.startsWith(WORKSPACE_ALIAS) ? i18n?.workspaceBaseUri : i18n?.resourceBaseUri) ?? "";
}

/**
 * `url` resolved against the document, or `url` unchanged when it is already
 * absolute, is empty, or there is no base to resolve against.
 */
export function resolveDocumentResource(url: string): string {
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith("#") || ABSOLUTE_URL_RE.test(trimmed)) {
        return url;
    }
    const base = baseFor(trimmed);
    if (!base) {
        return url;
    }
    const path = trimmed.startsWith(WORKSPACE_ALIAS) ? trimmed.slice(WORKSPACE_ALIAS.length) : trimmed;
    try {
        const resolved = new URL(path, base);
        // A webview URI may carry a query the resource loader needs, and
        // resolving a relative reference against it drops one. Put it back,
        // never over a query the author wrote themselves.
        const baseQuery = new URL(base).search;
        if (baseQuery && !resolved.search) {
            resolved.search = baseQuery;
        }
        return resolved.toString();
    } catch {
        // Not a URL the platform can resolve (a Windows drive letter reads as a
        // scheme, a stray `%` fails to decode). Authored bytes are the safe
        // answer: a broken image beats a mangled one.
        return url;
    }
}

/**
 * A `srcset` value with every candidate's URL resolved.
 *
 * Candidates are comma-separated and each is a URL followed by optional
 * descriptors. The spec forbids a leading or trailing comma in the URL itself,
 * so splitting on `,` and rewriting the first token of each entry is exact.
 */
function resolveSrcset(value: string): string {
    return value
        .split(",")
        .map((candidate) => {
            const match = /^(\s*)(\S+)(.*)$/.exec(candidate);
            if (!match) {
                return candidate;
            }
            const [, lead, url, rest] = match;
            return `${lead}${resolveDocumentResource(url!)}${rest}`;
        })
        .join(",");
}

/**
 * Resolve every relative resource URL under `root`, in place.
 *
 * Called on sanitized output, so what it walks is already the filtered DOM. It
 * rewrites the rendered attribute only; nothing here reaches the document.
 */
export function resolveResourceUrlsIn(root: ParentNode): void {
    if (!window.__i18n?.resourceBaseUri) {
        return;
    }
    for (const el of root.querySelectorAll(URL_SELECTOR)) {
        for (const attr of URL_ATTRS) {
            const value = el.getAttribute(attr);
            if (value === null) {
                continue;
            }
            const resolved = resolveDocumentResource(value);
            if (resolved !== value) {
                el.setAttribute(attr, resolved);
            }
        }
    }
    for (const el of root.querySelectorAll(SRCSET_SELECTOR)) {
        const value = el.getAttribute("srcset");
        if (value === null) {
            continue;
        }
        const resolved = resolveSrcset(value);
        if (resolved !== value) {
            el.setAttribute("srcset", resolved);
        }
    }
}
