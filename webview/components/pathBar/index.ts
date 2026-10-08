/**
 * components/pathBar/index.ts
 *
 * Where this window's file is, drawn along the window's foot: the folders from
 * a root the reader names down to the file, each a button that shows that
 * place in the host's file manager.
 *
 * The Finder's own path bar is the model for the drawing, less its chrome: an icon, a name and
 * a chevron per place, at reduced ink, with no ground of its own beyond the
 * page's and no border. It is read far more often than it is clicked, so it is
 * drawn as quiet as the formatting row is at rest, and comes up to full ink
 * under the pointer or keyboard focus.
 *
 * Every fact here is the host's. The segments arrive whole (`pathBar` in
 * shared/messages.ts), names included, because the names are the file
 * system's localized ones and the page cannot read a directory; and a click
 * hands the segment's path back (`revealPath`), which the host checks against
 * the bar it drew before it shows anything. The page builds a bar only while a
 * host hands it segments, so a surface that sends none (VS Code, whose
 * breadcrumbs already say this) never loads this chunk.
 *
 * Its leading edge is the formatting row's (toolbar/dock.css), keyed on the
 * same body classes, so the bar and the row start on one line however the
 * side panels are docked.
 *
 * A narrow window folds segments rather than squeezing them: the middle
 * folders go into one `…` button, nearest the root first (`collapse.ts`), and
 * the `…` asks the host for its own menu of them (`pathBarMenu`), drawn as the
 * title's path popup is. Every visible segment keeps its whole name except the
 * file's, which truncates once nothing else is left to fold.
 */
import type { PathBarSegment } from "../../../shared/messages";
import { t } from "../../i18n";
import { notifyPathBarMenu, notifyRevealPath } from "../../messaging";
import { IconChevronRight, IconEllipsis, IconFileText, IconFolder } from "../../ui/icons";
import { foldedSegments } from "./collapse";
import { IconCloud, IconHardDrive, IconHome } from "./icons";
import { ensurePathBarStyles } from "./styles";

export interface PathBarController {
    /** Draw these segments, or take the bar down for null. */
    set(segments: readonly PathBarSegment[] | null): void;
}

const ICONS: Record<PathBarSegment["kind"], string> = {
    cloud: IconCloud,
    home: IconHome,
    volume: IconHardDrive,
    folder: IconFolder,
    file: IconFileText,
};

/** What a click on a segment does, said to a screen reader and in the tooltip. */
function actionLabel(segment: PathBarSegment): string {
    return segment.kind === "file"
        ? `${t("Reveal in Finder")}: ${segment.name}`
        : `${t("Open in Finder")}: ${segment.name}`;
}

function chevron(): HTMLElement {
    const el = document.createElement("span");
    el.className = "path-bar__chevron";
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = IconChevronRight;
    return el;
}

interface Built {
    nav: HTMLElement;
    list: HTMLElement;
    /** One per segment, root first. */
    items: HTMLElement[];
    more: HTMLElement;
    moreButton: HTMLButtonElement;
    segments: readonly PathBarSegment[];
    /** Natural widths, taken once per path; a resize re-plans from these. */
    widths: number[] | null;
    moreWidth: number;
    folded: number[];
}

export function createPathBar(): PathBarController {
    ensurePathBarStyles();
    let built: Built | null = null;
    let frame = 0;

    const build = (segments: readonly PathBarSegment[]): Built => {
        const nav = document.createElement("nav");
        nav.className = "path-bar";
        nav.setAttribute("aria-label", t("File path"));
        const list = document.createElement("ol");
        list.className = "path-bar__list";
        const items = segments.map((segment, i) => {
            const item = document.createElement("li");
            item.className = "path-bar__item";
            if (i === segments.length - 1) { item.classList.add("path-bar__item--file"); }
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "ui-btn path-bar__segment";
            btn.dataset.kind = segment.kind;
            btn.title = actionLabel(segment);
            btn.setAttribute("aria-label", actionLabel(segment));
            if (i === segments.length - 1) { btn.setAttribute("aria-current", "location"); }
            const icon = document.createElement("span");
            icon.className = "path-bar__icon";
            icon.setAttribute("aria-hidden", "true");
            icon.innerHTML = ICONS[segment.kind];
            const label = document.createElement("span");
            label.className = "path-bar__label";
            label.textContent = segment.name;
            btn.append(icon, label);
            btn.addEventListener("click", () => notifyRevealPath(segment.path));
            item.appendChild(btn);
            if (i < segments.length - 1) { item.appendChild(chevron()); }
            return item;
        });
        // The `…`, after the root, so a fold of the middle reads root › … ›
        // and a fold that takes the root as well leads with it.
        const more = document.createElement("li");
        more.className = "path-bar__item path-bar__item--more";
        more.hidden = true;
        const moreButton = document.createElement("button");
        moreButton.type = "button";
        moreButton.className = "ui-btn path-bar__segment path-bar__more";
        moreButton.title = t("Show folders");
        moreButton.setAttribute("aria-label", t("Show folders"));
        moreButton.setAttribute("aria-haspopup", "menu");
        moreButton.innerHTML = `<span class="path-bar__icon" aria-hidden="true">${IconEllipsis}</span>`;
        more.append(moreButton, chevron());
        list.append(...items.slice(0, 1), more, ...items.slice(1));
        nav.appendChild(list);
        const state: Built = { nav, list, items, more, moreButton, segments, widths: null, moreWidth: 0, folded: [] };
        moreButton.addEventListener("click", () => {
            const r = moreButton.getBoundingClientRect();
            notifyPathBarMenu(state.folded.map((i) => ({ name: segments[i].name, path: segments[i].path })),
                r.left, r.top);
        });
        return state;
    };

    /** Take the natural widths, with nothing folded and nothing shrinking. */
    const measure = (b: Built): void => {
        b.nav.classList.add("path-bar--measuring");
        b.items.forEach((item) => { item.hidden = false; });
        b.more.hidden = false;
        b.widths = b.items.map((item) => item.getBoundingClientRect().width);
        b.moreWidth = b.more.getBoundingClientRect().width;
        b.nav.classList.remove("path-bar--measuring");
    };

    const fold = (b: Built): void => {
        if (!b.widths) { measure(b); }
        const available = b.list.clientWidth;
        b.folded = foldedSegments(b.widths ?? [], b.moreWidth, available);
        b.items.forEach((item, i) => { item.hidden = b.folded.includes(i); });
        b.more.hidden = b.folded.length === 0;
    };

    const observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => { if (built) { fold(built); } });
    });

    return {
        set(segments) {
            if (built) { observer.unobserve(built.nav); built.nav.remove(); }
            built = null;
            if (!segments?.length) { return; }
            built = build(segments);
            document.body.appendChild(built.nav);
            fold(built);
            observer.observe(built.nav);
        },
    };
}
