/**
 * Lazy loader for the path bar (components/pathBar).
 *
 * Only a host with a file manager to show a folder in ever sends `pathBar`,
 * and only while its setting is on, so the bar's module, icons and CSS sit
 * behind a dynamic `import()` fetched on the first non-null segments. Every
 * other launch evaluates none of it (AGENTS.md, Launch performance).
 *
 * The latest message wins: a `pathBar` arriving while the chunk is on its way
 * replaces the one before it, and a null before the chunk lands means the
 * chunk, when it lands, draws nothing.
 */
import type { PathBarSegment } from "../../shared/messages";
import type { PathBarController } from "../components/pathBar";

export interface PathBarGate {
    set(segments: readonly PathBarSegment[] | null): void;
}

export function createPathBarGate(): PathBarGate {
    let controller: PathBarController | null = null;
    let pending: Promise<unknown> | null = null;
    let latest: readonly PathBarSegment[] | null = null;

    return {
        set(segments) {
            latest = segments;
            if (controller) {
                controller.set(segments);
                return;
            }
            if (!segments || pending) { return; }
            const load$ = import("../components/pathBar");
            pending = load$;
            // No catch, as the line-number gutter's loader has none: a chunk
            // that fails to load is reported by the crash boundary.
            load$
                .then((module) => {
                    controller = module.createPathBar();
                    controller.set(latest);
                })
                .finally(() => {
                    if (pending === load$) { pending = null; }
                });
        },
    };
}
