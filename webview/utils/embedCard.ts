/**
 * webview/utils/embedCard.ts
 *
 * The embed CARD DOM builder (MAR-56, generalized in MAR-186) — a click-to-load
 * facade. This module is deliberately loaded through a cached dynamic `import()`
 * (see the embed plugin's loadEmbedCard), NEVER a static import: the launch
 * bundle must not carry the card builder, and a document with no embeds must not
 * pay for it (the same lazy-chunk discipline as katexLoader / mermaidLoader).
 *
 * Three card shapes, chosen by the provider's capabilities (embedProviders.ts):
 *   - THUMBNAIL FACADE (YouTube): static thumbnail + play overlay; the real
 *     <iframe> is constructed ONLY inside the play handler.
 *   - BRANDED FACADE (Loom, Figma): same frame + play overlay, but a local
 *     monochrome provider mark instead of a thumbnail — ZERO network at render.
 *   - INFO CARD (GitHub): a compact row built from URL parts alone — no frame,
 *     no play, no iframe path at all; it works with the network switch off.
 *
 * No network beyond a thumbnail-capable provider's one thumbnail image until the
 * user clicks. All chrome is themed with --vscode-* tokens; the accent is
 * var(--vscode-focusBorder) with no literal fallback. The provider marks are
 * monochrome currentColor by design — brand colors would fight the "color
 * encodes the source" budget and the no-color-literals rule.
 */
import {
    providerFor,
    githubCardParts,
    type EmbedMatch,
    type EmbedProvider,
} from "./embedProviders";
import { notifyOpenUrl } from "../messaging";
import { t } from "../i18n";
// icons.ts is already in the eager bundle; importing shared glyphs here only
// references that module — it de-duplicates without growing either chunk.
import { IconExternalLink, IconEye } from "../ui/icons";

/** A play-triangle glyph, painted with currentColor (video providers). */
const PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;

/** Overlay glyphs by the provider table's activateIcon key. A play triangle
 * promises playback, so an interactive canvas (Figma) gets the preview eye. */
const ACTIVATE_ICONS = { play: PLAY_ICON, preview: IconEye } as const;

/**
 * Monochrome provider marks, local to this lazy chunk (ui/icons.ts is in the
 * eager bundle; only cards need these). Each paints with currentColor.
 */
const PROVIDER_MARKS: Partial<Record<EmbedMatch["kind"], string>> = {
    // An eight-spoke pinwheel — Loom's mark reduced to strokes.
    loom: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5M5.3 5.3l3.5 3.5M15.2 15.2l3.5 3.5M18.7 5.3l-3.5 3.5M8.8 15.2l-3.5 3.5"/></svg>`,
    // Figma's five-lobe glyph, single color.
    figma: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor"><path d="M12 2H8.5a3.5 3.5 0 0 0 0 7H12V2zM12 9H8.5a3.5 3.5 0 0 0 0 7H12V9zM12 16H8.5a3.5 3.5 0 1 0 3.5 3.5V16zM12 2h3.5a3.5 3.5 0 0 1 0 7H12V2z"/><circle cx="15.5" cy="12.5" r="3.5"/></svg>`,
    // The GitHub octocat silhouette (Octicons, MIT).
    github: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.18-.02-2.14-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.16 1.18a11 11 0 0 1 5.76 0c2.19-1.49 3.15-1.18 3.15-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14 0 1.54-.01 2.79-.01 3.17 0 .31.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"/></svg>`,
};

/**
 * Make a card button safe inside the contenteditable root: mousedown must not
 * move the editor caret, and Enter / Space on a focused button must activate it
 * rather than type into the document. Same contract as ui/foldEllipsis.ts,
 * which solves this for the fold widget.
 *
 * The mousedown half is defensive — the caret does not in practice land inside
 * a contenteditable="false" widget, so the card survives a click without it
 * (verified in e2e). The keyboard half is load-bearing: a focused button inside
 * contenteditable would otherwise let Space through as typed input.
 */
function guardActivation(button: HTMLElement): void {
    button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    button.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            button.click();
        }
    });
}

/**
 * Swap the facade for the live player. Built only on the user's click — this is
 * the sole place an <iframe> is ever created, and the only autoplay (the user
 * just asked for it). Providers without a playerUrl never reach here.
 */
function loadPlayer(frame: HTMLElement, provider: EmbedProvider, id: string): void {
    const iframe = document.createElement("iframe");
    iframe.className = "embed-card__iframe";
    iframe.src = provider.playerUrl!(id);
    // Capability containment (adversarial-review hardening, 2026-07-24): CSP
    // frame-src pins WHICH hosts may be framed; sandbox constrains what the
    // framed page may DO. All three players are script-driven and need their
    // own storage (allow-scripts + allow-same-origin); allow-popups covers
    // in-player external links (popups inherit the sandbox); presentation
    // covers cast/fullscreen flows. Deliberately absent: forms, downloads,
    // top-navigation, pointer-lock — and clipboard-write from the allow list,
    // which playback never needed.
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-presentation");
    iframe.setAttribute("allow", "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture");
    iframe.setAttribute("allowfullscreen", "");
    // Some providers refuse playback without a referrer they recognize —
    // YouTube's "Error 153 — video player configuration error" is the canonical
    // case. A webview's opaque origin may never satisfy that; this attribute
    // makes the browser send what it can, and the card's explicit external-open
    // button is the guaranteed path (links INSIDE a provider's own error screen
    // are sandboxed and go nowhere).
    iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    iframe.setAttribute("title", t(provider.playerTitle ?? "Embedded content"));
    frame.replaceChildren(iframe);
}

/**
 * The external-open button every card carries: in-webview playback is at the
 * provider's mercy (see the referrer note in loadPlayer), so an escape hatch to
 * the real page must always work. It routes through the extension's
 * external-open flow (VS Code's own trusted-domains prompt included).
 */
function externalButton(provider: EmbedProvider, id: string, sourceUrl?: string): HTMLElement {
    const external = document.createElement("button");
    external.type = "button";
    external.className = "embed-card__external";
    external.title = t(provider.openLabel);
    external.setAttribute("aria-label", t(provider.openLabel));
    external.innerHTML = IconExternalLink;
    external.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        notifyOpenUrl(sourceUrl ?? provider.externalUrl(id));
    });
    guardActivation(external);
    return external;
}

/** The empty card shell every variant fills: kind-stamped, non-editable. */
function cardShell(provider: EmbedProvider): HTMLElement {
    const card = document.createElement("div");
    card.className = "embed-card";
    card.dataset["embedKind"] = provider.kind;
    card.setAttribute("contenteditable", "false");
    return card;
}

/**
 * A player card: facade (thumbnail or branded) + play overlay + external
 * button; the iframe replaces the facade only on the play click.
 */
function renderPlayerCard(provider: EmbedProvider, id: string, sourceUrl?: string): HTMLElement {
    const card = cardShell(provider);
    if (provider.aspect) {
        card.style.setProperty("--embed-aspect", provider.aspect);
    }

    const frame = document.createElement("div");
    frame.className = "embed-card__frame";

    if (provider.thumbnailUrl) {
        const thumb = document.createElement("img");
        thumb.className = "embed-card__thumb";
        thumb.loading = "lazy";
        thumb.src = provider.thumbnailUrl(id);
        thumb.alt = t("Video thumbnail");
        frame.appendChild(thumb);
    } else {
        // Branded facade: a local monochrome mark + the provider's name.
        // Nothing here touches the network — that is the point.
        const brand = document.createElement("div");
        brand.className = "embed-card__brand";
        brand.innerHTML = `${PROVIDER_MARKS[provider.kind] ?? ""}<span class="embed-card__brand-name">${provider.name}</span>`;
        frame.appendChild(brand);
    }

    const play = document.createElement("button");
    play.type = "button";
    play.className = "embed-card__play";
    play.setAttribute("aria-label", t(provider.activateLabel ?? "Load preview"));
    play.innerHTML = ACTIVATE_ICONS[provider.activateIcon ?? "play"];
    play.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        loadPlayer(frame, provider, id);
    });
    guardActivation(play);
    frame.appendChild(play);

    frame.appendChild(externalButton(provider, id, sourceUrl));
    card.appendChild(frame);
    return card;
}

/**
 * The GitHub info card: a compact row derived entirely from the URL — mark,
 * `owner/repo` title, and a detail line for PRs / issues / file paths. No
 * frame, no play button, and no code path that could ever create an iframe.
 */
function renderInfoCard(provider: EmbedProvider, id: string, sourceUrl?: string): HTMLElement {
    const card = cardShell(provider);
    card.classList.add("embed-card--info");

    const mark = document.createElement("span");
    mark.className = "embed-card__mark";
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = PROVIDER_MARKS[provider.kind] ?? "";
    card.appendChild(mark);

    const text = document.createElement("span");
    text.className = "embed-card__text";
    const title = document.createElement("span");
    title.className = "embed-card__title";
    const detail = document.createElement("span");
    detail.className = "embed-card__detail";

    const parts = githubCardParts(id);
    title.textContent = `${parts.owner}/${parts.repo}`;
    if (parts.kind === "pull") {
        detail.textContent = `${t("Pull request")} #${parts.number}`;
    } else if (parts.kind === "issue") {
        detail.textContent = `${t("Issue")} #${parts.number}`;
    } else if (parts.kind === "blob") {
        detail.textContent = parts.path ?? "";
    }

    text.appendChild(title);
    if (detail.textContent) {
        text.appendChild(detail);
    }
    card.appendChild(text);
    card.appendChild(externalButton(provider, id, sourceUrl));
    return card;
}

/**
 * Build the card for a recognized embed. The card is non-editable chrome (it
 * rides a widget decoration, outside the document), so it never traps the
 * caret, and nothing it does can reach the serialized markdown.
 */
export function renderEmbedCard(match: EmbedMatch, sourceUrl?: string): HTMLElement {
    const provider = providerFor(match.kind);
    return provider.playerUrl
        ? renderPlayerCard(provider, match.id, sourceUrl)
        : renderInfoCard(provider, match.id, sourceUrl);
}
