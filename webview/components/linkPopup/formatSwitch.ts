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
import { syntaxAllows } from "../../../shared/syntaxSets";

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

    // Name + example shape, so the choice is legible even to someone who
    // doesn't recognize the raw syntax. The native <select> trigger shows the
    // selected option's text, so it reads e.g. "Markdown — [text](url)".
    const optMarkdown = document.createElement("option");
    optMarkdown.value = "markdown";
    optMarkdown.textContent = t("Markdown — [text](url)");

    const optWiki = document.createElement("option");
    optWiki.value = "wikilink";
    optWiki.textContent = t("Wikilink — [[page]]");

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
            // Two reasons there may be no choice to offer, and one treatment.
            // The target can be one (an external URL, a #anchor), or the
            // reader's syntax sets do not spell wikilinks at all
            // (shared/syntaxSets.ts). Either way, hide the whole Format row
            // rather than show a greyed-out option, and force markdown.
            //
            // A link that IS already a wikilink keeps the control whatever the
            // target says, and that carve-out is what stops this from
            // rewriting the document: forcing markdown on an existing wikilink
            // would convert a link the author typed, on a target change they
            // made for the links they are about to write. Converting it is
            // still one pick away, which is the direction a narrowed target
            // wants to be easy.
            const isWiki = select.value === "wikilink";
            const offer = allowed && (isWiki || syntaxAllows("wikiLink"));
            root.style.display = offer ? "" : "none";
            if (!offer && isWiki) {
                select.value = "markdown";
            }
        },
    };
}
