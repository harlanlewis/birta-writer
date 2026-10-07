/**
 * webview/firstScreen.ts
 *
 * When the page tells its host that its first screen is up (`firstScreen`).
 *
 * A host that shows a page before it has finished building shows the build:
 * paper with no editor, then an editor at full width, then a file list that
 * pushes it over. The Mac app opens a tab beside another, and reloads a
 * window's page in place, without showing either until this message arrives,
 * so what a reader sees first is the window as it will stay.
 *
 * "Up" means three things, in order:
 *
 * 1. `init` has been handled: the editor is mounted (or the banner that
 *    stands in for one is drawn), with the caret and scroll it opened at.
 * 2. The side panels the host's declaration builds at boot have settled,
 *    which today is the file explorer's first tree (`settled` on its gate).
 *    That wait is bounded by `SIDE_PANEL_GRACE_MS`: the editor is the screen,
 *    and a folder on a slow volume must not hold it back. Its rows land where
 *    the panel already stands when they come.
 * 3. One painted frame, so a host that lifts a cover on this message lifts it
 *    off a page that has drawn. A page that is hidden posts at once instead:
 *    it paints nothing until it is shown, a frame request waits for that, and
 *    the host that hid it is waiting for this message to show it. The work a
 *    hidden page has queued for its next frame (a side panel's opening commit)
 *    runs before that first visible paint, so it is part of what is shown.
 *
 * Once per page. A re-init (an external change the editor could not merge)
 * rebuilds the editor inside a page that is already on screen, and there is
 * nobody waiting.
 */
import { notifyFirstScreen } from "./messaging";

/** How long the first screen waits for a side panel's contents beyond the editor. */
export const SIDE_PANEL_GRACE_MS = 250;

export interface FirstScreen {
    /** `init` has been handled; post once `sidePanels` settles (or the grace runs out) and a frame paints. */
    announce(sidePanels: Promise<void>): void;
}

export function createFirstScreen(post: () => void = notifyFirstScreen): FirstScreen {
    let announced = false;
    return {
        announce(sidePanels) {
            if (announced) { return; }
            announced = true;
            let sent = false;
            const send = (): void => {
                if (sent) { return; }
                sent = true;
                document.removeEventListener("visibilitychange", onHidden);
                post();
            };
            // A page hidden while it waits for its frame would wait until it
            // is shown again, which is the host's to decide and the host is
            // waiting on this. Armed only once the screen is complete: hidden
            // before then, it is still not up.
            const onHidden = (): void => {
                if (document.visibilityState === "hidden") { send(); }
            };
            const afterPaint = (): void => {
                if (document.visibilityState === "hidden") { send(); return; }
                document.addEventListener("visibilitychange", onHidden);
                requestAnimationFrame(() => requestAnimationFrame(send));
            };
            const grace = new Promise<void>((resolve) => { setTimeout(resolve, SIDE_PANEL_GRACE_MS); });
            void Promise.race([sidePanels, grace]).then(afterPaint);
        },
    };
}
