/**
 * Link format switch — the two-option segmented control (markdown / wikilink)
 * shared by the link popup's edit body and the toolbar's insert-link prompt.
 * A document legitimately mixes both forms, so creation and editing offer the
 * format as an explicit choice; standard markdown is always the default for
 * new links, an existing link starts on its own current format.
 *
 * The wikilink option disables for external targets (scheme URLs, #anchors) —
 * a wikilink names a workspace file, never a URL.
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
    /** Disables the wikilink option; forces markdown while disallowed. */
    setWikiAllowed(allowed: boolean): void;
}

export function createLinkFormatSwitch(
    initial: LinkFormat = "markdown",
    onChange?: (format: LinkFormat) => void,
): FormatSwitch {
    let format: LinkFormat = initial;
    let wikiAllowed = true;

    const root = document.createElement("div");
    root.className = "lfs-root";
    root.setAttribute("role", "radiogroup");
    root.setAttribute("aria-label", t("Link format"));

    const make = (value: LinkFormat, label: string): HTMLButtonElement => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "lfs-btn";
        b.textContent = label;
        b.setAttribute("role", "radio");
        b.addEventListener("mousedown", (e) => {
            // preventDefault keeps focus in the hosting input (a blur would
            // close the popup/prompt before the choice lands).
            e.preventDefault();
            e.stopPropagation();
            if (b.disabled || format === value) { return; }
            format = value;
            paint();
            onChange?.(value);
        });
        return b;
    };

    const btnMd = make("markdown", t("markdown"));
    const btnWiki = make("wikilink", t("[[wiki]]"));
    root.append(btnMd, btnWiki);

    function paint(): void {
        btnMd.classList.toggle("lfs-btn--active", format === "markdown");
        btnMd.setAttribute("aria-checked", format === "markdown" ? "true" : "false");
        btnWiki.classList.toggle("lfs-btn--active", format === "wikilink");
        btnWiki.setAttribute("aria-checked", format === "wikilink" ? "true" : "false");
        btnWiki.disabled = !wikiAllowed;
    }
    paint();

    return {
        el: root,
        get: () => format,
        set(f: LinkFormat): void {
            format = f;
            paint();
        },
        setWikiAllowed(allowed: boolean): void {
            wikiAllowed = allowed;
            if (!allowed && format === "wikilink") { format = "markdown"; }
            paint();
        },
    };
}
