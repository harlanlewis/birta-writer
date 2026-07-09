/**
 * Link format switch — the labeled "Format" dropdown (markdown / wikilink)
 * shared by the link popup's edit body. A document legitimately mixes both
 * forms, so creation and editing offer the format as an explicit choice;
 * standard markdown is always the default for new links, an existing link
 * starts on its own current format.
 *
 * The wikilink option disables for external targets (scheme URLs, #anchors) —
 * a wikilink names a workspace file, never a URL. A native <select> is used
 * so keyboard and screen-reader interaction come for free.
 */
import "./formatSwitch.css";
import { t } from "@/i18n";

export type LinkFormat = "markdown" | "wikilink";

/**
 * A real external URL (scheme://… or mailto:) — deliberately NOT any
 * `word:` prefix: wikilink targets like "note: plan" are ordinary note
 * titles, and misreading them once force-flipped the switch and rewrote
 * the document on a stray click.
 */
const EXTERNAL_URL_REGEX = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/|mailto:)/i;

/** Whether a link target can be expressed as a wikilink at all. */
export function wikiAllowedFor(url: string): boolean {
    const u = url.trim();
    return !EXTERNAL_URL_REGEX.test(u) && !u.startsWith("#");
}

export interface FormatSwitch {
    el: HTMLElement;
    get(): LinkFormat;
    set(format: LinkFormat): void;
    /** Hides the whole control when a wikilink is impossible; forces markdown. */
    setWikiAllowed(allowed: boolean): void;
}

export function createLinkFormatSwitch(
    initial: LinkFormat = "markdown",
    onChange?: (format: LinkFormat) => void,
): FormatSwitch {
    const root = document.createElement("div");
    root.className = "lfs-root";

    // Visual prefix ("Local link format:"). The control only appears when the
    // target can be a wikilink (a local file), so the label names that context.
    // The accessible name lives on the select.
    const label = document.createElement("span");
    label.className = "lfs-label";
    label.textContent = t("Local link format");
    label.setAttribute("aria-hidden", "true");

    const select = document.createElement("select");
    select.className = "lfs-select";
    select.setAttribute("aria-label", t("Local link format"));

    const optMarkdown = document.createElement("option");
    optMarkdown.value = "markdown";
    optMarkdown.textContent = t("[text](url)");

    const optWiki = document.createElement("option");
    optWiki.value = "wikilink";
    optWiki.textContent = t("[[page]]");

    select.append(optMarkdown, optWiki);
    select.value = initial;

    root.append(label, select);

    // Native change only fires on a real user choice — programmatic set()
    // and setWikiAllowed() below never dispatch it, so an untouched link is
    // never rewritten on a stray reposition.
    select.addEventListener("change", () => {
        onChange?.(select.value as LinkFormat);
    });

    return {
        el: root,
        get: () => select.value as LinkFormat,
        set(format: LinkFormat): void {
            select.value = format;
        },
        setWikiAllowed(allowed: boolean): void {
            // When a wikilink is impossible (external URL / #anchor) there is no
            // real choice to offer — hide the whole Format row rather than show a
            // greyed-out option, and force markdown.
            root.style.display = allowed ? "" : "none";
            if (!allowed && select.value === "wikilink") {
                select.value = "markdown";
            }
        },
    };
}
