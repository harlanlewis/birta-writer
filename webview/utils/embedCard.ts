/**
 * webview/utils/embedCard.ts
 *
 * The embed CARD DOM builder (MAR-56) — a click-to-load facade. This module is
 * deliberately loaded through a cached dynamic `import()` (see the embed plugin's
 * loadEmbedCard), NEVER a static import: the launch bundle must not carry the
 * card builder, and a document with no embeds must not pay for it (the same
 * lazy-chunk discipline as katexLoader / mermaidLoader).
 *
 * FACADE, not an eager player: the card shows only a static thumbnail image plus
 * a play overlay. The real <iframe> player is constructed ONLY inside the play
 * button's click handler — nothing here builds an iframe at render time (mirrors
 * imageView's lightbox building heavy DOM on click). No network beyond the one
 * thumbnail image until the user clicks play.
 *
 * All chrome is themed with --vscode-* tokens; the accent is
 * var(--vscode-focusBorder) with no literal fallback.
 */
import { youtubeThumbnailUrl, youtubeEmbedUrl, type EmbedMatch } from "./embedProviders";
import { notifyOpenUrl } from "../messaging";
import { t } from "../i18n";

/** A play-triangle glyph, painted with currentColor. */
const PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;

/** External-link glyph (arrow out of a box), painted with currentColor. */
const EXTERNAL_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;

/**
 * Swap the facade for the live player. Built only on the user's click — this is
 * the sole place an <iframe> is ever created, and the only autoplay (the user
 * just asked for it).
 */
function loadPlayer(frame: HTMLElement, match: EmbedMatch): void {
    const iframe = document.createElement("iframe");
    iframe.className = "embed-card__iframe";
    iframe.src = `${youtubeEmbedUrl(match.id)}?autoplay=1`;
    iframe.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture");
    iframe.setAttribute("allowfullscreen", "");
    // YouTube refuses playback without a referrer it recognizes ("Error 153 —
    // video player configuration error"). A webview's opaque origin may never
    // satisfy that; this attribute makes the browser send what it can, and the
    // card's explicit "Open on YouTube" button is the guaranteed path (the
    // link INSIDE YouTube's own error screen is sandboxed and goes nowhere).
    iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    iframe.setAttribute("title", t("YouTube video player"));
    frame.replaceChildren(iframe);
}

/**
 * Build the facade card for a recognized embed. Static thumbnail + play overlay;
 * the player iframe is created only when the play button is clicked. The card is
 * non-editable chrome (it rides a widget decoration, outside the document), so
 * it never traps the caret.
 */
export function renderEmbedCard(match: EmbedMatch, sourceUrl?: string): HTMLElement {
    const card = document.createElement("div");
    card.className = "embed-card";
    card.dataset["embedKind"] = match.kind;
    card.setAttribute("contenteditable", "false");

    const frame = document.createElement("div");
    frame.className = "embed-card__frame";

    const thumb = document.createElement("img");
    thumb.className = "embed-card__thumb";
    thumb.loading = "lazy";
    thumb.src = youtubeThumbnailUrl(match.id);
    thumb.alt = t("YouTube video thumbnail");
    frame.appendChild(thumb);

    const play = document.createElement("button");
    play.type = "button";
    play.className = "embed-card__play";
    play.setAttribute("aria-label", t("Play video"));
    play.innerHTML = PLAY_ICON;
    play.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        loadPlayer(frame, match);
    });
    frame.appendChild(play);

    // Guaranteed external path: in-webview playback is at YouTube's mercy
    // (see the referrer note in loadPlayer), and once its error screen shows,
    // every link inside the sandboxed iframe is dead. This button always
    // works — it routes through the extension's external-open flow (VS Code's
    // own trusted-domains prompt included).
    const external = document.createElement("button");
    external.type = "button";
    external.className = "embed-card__external";
    external.title = t("Open on YouTube");
    external.setAttribute("aria-label", t("Open on YouTube"));
    external.innerHTML = EXTERNAL_ICON;
    external.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        notifyOpenUrl(sourceUrl ?? `https://www.youtube.com/watch?v=${match.id}`);
    });
    frame.appendChild(external);

    card.appendChild(frame);
    return card;
}
