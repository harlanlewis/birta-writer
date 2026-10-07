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
 */
import type { PathBarSegment } from "../../../shared/messages";
import { t } from "../../i18n";
import { notifyRevealPath } from "../../messaging";
import { IconChevronRight, IconFileText, IconFolder } from "../../ui/icons";
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

export function createPathBar(): PathBarController {
    ensurePathBarStyles();
    let nav: HTMLElement | null = null;

    const build = (segments: readonly PathBarSegment[]): HTMLElement => {
        const el = document.createElement("nav");
        el.className = "path-bar";
        el.setAttribute("aria-label", t("File path"));
        const list = document.createElement("ol");
        list.className = "path-bar__list";
        segments.forEach((segment, i) => {
            const item = document.createElement("li");
            item.className = "path-bar__item";
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
            if (i < segments.length - 1) {
                const chevron = document.createElement("span");
                chevron.className = "path-bar__chevron";
                chevron.setAttribute("aria-hidden", "true");
                chevron.innerHTML = IconChevronRight;
                item.appendChild(chevron);
            }
            list.appendChild(item);
        });
        el.appendChild(list);
        return el;
    };

    return {
        set(segments) {
            nav?.remove();
            nav = null;
            if (!segments?.length) { return; }
            nav = build(segments);
            document.body.appendChild(nav);
        },
    };
}
