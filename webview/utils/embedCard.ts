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
import { subscribeEmbedMeta } from "../embedMeta";
import { t } from "../i18n";
// icons.ts is already in the eager bundle; importing shared glyphs here only
// references that module — it de-duplicates without growing either chunk.
import { IconExternalLink, IconLink, IconPencil, IconX } from "../ui/icons";
// The shared tooltip (eager ui module): control-column tips open LEFT, over
// the embed, so they never clip at the content edge or cover the next button.
import { applyTooltip } from "../ui/tooltip";

/** A play-triangle glyph, painted with currentColor (video providers). A
 * non-video surface (Figma) gets a labeled text pill instead of any glyph. */
const PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;

/**
 * The one provider mark still drawn: GitHub's octocat, the genuine Octicons
 * silhouette (MIT). Facades carry NO drawn marks — hand-reduced "brand"
 * glyphs read as generic or invented (Loom's pinwheel looked like a loading
 * spinner; a chevron-V says nothing), so the facade states the service NAME
 * in text instead (user direction 2026-07-27).
 */
const PROVIDER_MARKS: Partial<Record<EmbedMatch["kind"], string>> = {
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
 * The readable identity of a card's URL: host + path, scheme and `www.`
 * stripped, middle-truncated so both the host and the id-bearing tail survive.
 * The full URL always rides the element's title attribute.
 */
export function readableUrl(raw: string, max = 48): string {
    let text = raw;
    try {
        const url = new URL(raw);
        text = url.hostname.replace(/^www\./, "") + url.pathname.replace(/\/$/, "") + url.search;
    } catch { /* not a URL — show the raw text */ }
    if (text.length <= max) {
        return text;
    }
    const head = Math.ceil((max - 1) * 0.6);
    return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
}

/**
 * Swap the facade for the live player. Built only on the user's click — this
 * is the sole place an <iframe> is ever created. No autoplay is requested:
 * see EmbedProvider.playerUrl — a webview's activation never delegates into a
 * fresh cross-origin iframe, so requested autoplay just blocks and spins; the
 * provider's own play button is the reliable gesture.
 */
function loadPlayer(stage: HTMLElement, provider: EmbedProvider, id: string): void {
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
    stage.replaceChildren(iframe);
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
    external.setAttribute("aria-label", t(provider.openLabel));
    external.innerHTML = IconExternalLink;
    applyTooltip(external, t(provider.openLabel), { placement: "left" });
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
 * The branded block: the service NAME in text (no drawn mark — see
 * PROVIDER_MARKS), pinned to the frame's upper-left corner like a broadcast
 * bug. Zero network by construction.
 */
function brandBlock(provider: EmbedProvider): HTMLElement {
    const brand = document.createElement("div");
    brand.className = "embed-card__brand";
    const name = document.createElement("span");
    name.className = "embed-card__brand-name";
    name.textContent = provider.name;
    brand.appendChild(name);
    return brand;
}

/**
 * A player card: facade (thumbnail or branded) + activate overlay in a
 * replaceable STAGE, with the corner controls OUTSIDE it — so the external-open
 * escape hatch survives the play click (it used to be destroyed with the
 * facade), and a stop button can restore the facade.
 *
 * Click semantics split by surface: the MEDIA area (the whole facade, not just
 * the overlay button) activates the player, and the META strip — the resident
 * title + URL rows along the frame's bottom edge — bubbles to the widget host,
 * which selects the card and raises the palette. Media area does the media
 * verb; text area does the edit verbs.
 */
function renderPlayerCard(provider: EmbedProvider, id: string, sourceUrl?: string, actions?: EmbedCardActions): HTMLElement {
    const card = cardShell(provider);
    if (provider.aspect) {
        card.style.setProperty("--embed-aspect", provider.aspect);
    }

    const frame = document.createElement("div");
    frame.className = "embed-card__frame";
    const stage = document.createElement("div");
    stage.className = "embed-card__stage";

    // An in-frame hint for providers whose loaded embed can legitimately come
    // up blank (an auth-walled Figma file: the sandbox blocks in-frame login
    // by design). It IS the way out — a persistent, clickable row inside the
    // otherwise-blank rectangle that opens the page externally; nobody should
    // have to hunt for the corner button.
    const hint = document.createElement("button");
    hint.type = "button";
    hint.className = "embed-card__hint";
    hint.hidden = true;
    if (provider.kind === "figma") {
        const note = document.createElement("span");
        note.textContent = t("Preview blank? The file may need sign-in.");
        const action = document.createElement("span");
        action.className = "embed-card__hint-action";
        action.textContent = `${t(provider.openLabel)} ↗`;
        hint.append(note, " ", action);
        hint.setAttribute("aria-label", t(provider.openLabel));
        hint.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            notifyOpenUrl(sourceUrl ?? provider.externalUrl(id));
        });
        guardActivation(hint);
    }

    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "embed-card__stop";
    stop.setAttribute("aria-label", t("Close player"));
    stop.innerHTML = IconX;
    applyTooltip(stop, t("Close player"), { placement: "left" });
    stop.hidden = true;
    stop.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showFacade();
    });
    guardActivation(stop);

    // The identity strip: resident title + URL, no hover required, BELOW the
    // frame and visible at all times — playing included (the metadata stays
    // useful after the player loads). The title row fills when (and only
    // when) oEmbed metadata resolves — textContent always, never markup — and
    // hides while empty (`:empty` CSS); the URL row is always present, full
    // URL in the tooltip and editable in the palette, which overlays this
    // strip while it is open.
    const meta = document.createElement("div");
    meta.className = "embed-card__meta";
    const metaTitle = document.createElement("span");
    metaTitle.className = "embed-card__meta-title";
    const metaUrl = document.createElement("span");
    metaUrl.className = "embed-card__meta-url";
    const url = sourceUrl ?? provider.externalUrl(id);
    metaUrl.textContent = readableUrl(url);
    metaUrl.title = url;
    meta.appendChild(metaTitle);
    meta.appendChild(metaUrl);
    if (provider.hasMetadata) {
        subscribeEmbedMeta(provider.kind, id, (title) => {
            if (title) {
                metaTitle.textContent = title;
            }
        });
    }

    const activate = (): void => {
        loadPlayer(stage, provider, id);
        card.classList.add("embed-card--playing");
        stop.hidden = false;
        hint.hidden = provider.kind !== "figma";
    };

    // The WHOLE facade is the activate target (the overlay button is the
    // visual verb, not the only hit area — a 4:3 frame of dead space that
    // looks clickable but isn't reads as broken). Guarded off while playing:
    // the iframe owns its surface then, and this must never swallow a click
    // that was meant for it (it can't — the iframe consumes them — but the
    // guard keeps the intent explicit).
    stage.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    stage.addEventListener("click", (event) => {
        if (card.classList.contains("embed-card--playing")) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        activate();
    });

    const showFacade = (): void => {
        const play = document.createElement("button");
        play.type = "button";
        play.setAttribute("aria-label", t(provider.activateLabel ?? "Load preview"));
        if (provider.activateIcon === "preview") {
            // An interactive canvas gets an EXPLICIT labeled pill — a glyph
            // alone (the old eye) promised nothing specific.
            play.className = "embed-card__play embed-card__play--label";
            play.textContent = t(provider.activateLabel ?? "Load preview");
        } else {
            play.className = "embed-card__play";
            play.innerHTML = PLAY_ICON;
        }
        play.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            activate();
        });
        guardActivation(play);

        if (provider.thumbnailUrl) {
            const thumb = document.createElement("img");
            thumb.className = "embed-card__thumb";
            thumb.loading = "lazy";
            thumb.src = provider.thumbnailUrl(id);
            thumb.alt = t("Video thumbnail");
            // A dead thumbnail (removed video, offline CDN) must not read as a
            // blank card: degrade to the branded facade, keep the play button —
            // the video itself may still exist.
            thumb.addEventListener("error", () => {
                thumb.replaceWith(brandBlock(provider));
            });
            // Artwork facade: the thumbnail fills the frame; the play overlay
            // floats centered above it.
            stage.replaceChildren(thumb, play);
        } else {
            // Branded facade: the name sits in the frame's upper-left corner,
            // the activate control centered — separate corners, no overlap.
            stage.replaceChildren(brandBlock(provider), play);
        }
        card.classList.remove("embed-card--playing");
        stop.hidden = true;
        hint.hidden = true;
    };
    showFacade();

    // The corner controls live OUTSIDE the frame, in a column to its right —
    // an embedded player owns its own top-right corner (Vimeo's fullscreen/PiP
    // cluster sat exactly under ours), and that collision recurs for arbitrary
    // embeds. Our chrome and theirs never overlap.
    const controls = document.createElement("div");
    controls.className = "embed-card__controls";
    controls.appendChild(stop);
    controls.appendChild(externalButton(provider, id, sourceUrl));
    if (actions) {
        const makeVerb = (className: string, icon: string, label: string, run: () => void): HTMLButtonElement => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = className;
            btn.setAttribute("aria-label", label);
            btn.innerHTML = icon;
            applyTooltip(btn, label, { placement: "left" });
            btn.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                run();
            });
            guardActivation(btn);
            return btn;
        };
        controls.appendChild(makeVerb("embed-card__edit", IconPencil, t("Edit embed"), actions.edit));
        controls.appendChild(makeVerb("embed-card__aslink", IconLink, t("Show as text link"), actions.removePreview));
    }

    frame.appendChild(stage);
    frame.appendChild(hint);
    card.classList.add("embed-card--player");
    card.appendChild(frame);
    card.appendChild(controls);
    card.appendChild(meta);
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
 * Document-touching verbs the card cannot own (they need the editor view):
 * supplied by the widget host in plugins/embed.ts. `edit` selects the card and
 * opens the palette on its URL; `removePreview` converts the bare link to a
 * labeled text link — the never-carded form — in one undo step.
 */
export interface EmbedCardActions {
    edit: () => void;
    removePreview: () => void;
}

/**
 * Build the card for a recognized embed. The card is non-editable chrome (it
 * rides a widget decoration, outside the document), so it never traps the
 * caret; the only paths that can reach the serialized markdown are the two
 * host-supplied actions above — explicit user verbs, never side effects.
 */
export function renderEmbedCard(match: EmbedMatch, sourceUrl?: string, actions?: EmbedCardActions): HTMLElement {
    const provider = providerFor(match.kind);
    return provider.playerUrl
        ? renderPlayerCard(provider, match.id, sourceUrl, actions)
        : renderInfoCard(provider, match.id, sourceUrl);
}
