/**
 * Lazy loader for the source line-number gutter.
 *
 * `birta.lineNumbers` is OFF by default, so the gutter's module — the index
 * walk, the placement arithmetic, the layer, its CSS — is pulled in through a
 * dynamic `import()` and code-split into its own chunk (`splitting: true` in
 * esbuild.mjs). A launch that never enables the setting fetches none of it and
 * evaluates none of it: the disabled feature costs exactly nothing, which is the
 * standing rule for anything decoration-shaped (AGENTS.md → Launch performance).
 *
 * This module is what the eager graph holds instead. It is deliberately tiny and
 * imports nothing but its own types, so being on the launch path is free.
 *
 * The gate is a "wanted" flag rather than a promise the callers await: enabling
 * and disabling are user actions that can land in any order (a settings toggle
 * mid-load), so the flag is the single source of truth and the load resolves
 * into whatever the user last asked for.
 */
import type { LineNumbersController, LineNumbersHost } from "../components/lineNumbers";

export interface LineNumbersGate {
    /** Turn the gutter on or off; loads the module on the first `true`. */
    setEnabled(enabled: boolean): void;
    /**
     * The document, the source, the fold state or the layout changed. A no-op
     * while the gutter is off or still loading — cheap enough to call from the
     * doc-change path without a guard at the call site.
     */
    refresh(): void;
}

export function createLineNumbersGate(host: LineNumbersHost): LineNumbersGate {
    let controller: LineNumbersController | null = null;
    let pending: Promise<unknown> | null = null;
    let wanted = false;

    const load = (): void => {
        if (controller || pending) { return; }
        const load$ = import("../components/lineNumbers");
        pending = load$;
        // No catch: a chunk that fails to load is a real failure, and the
        // webview's crash boundary (crashReporter.ts) is what reports it. The
        // `finally` only clears the in-flight guard so a later toggle retries.
        load$
            .then((module) => {
                controller = module.createLineNumbers(host);
                if (wanted) { controller.enable(); }
            })
            .finally(() => {
                if (pending === load$) { pending = null; }
            });
    };

    return {
        setEnabled(enabled) {
            wanted = enabled;
            if (!enabled) {
                controller?.disable();
                return;
            }
            if (controller) { controller.enable(); } else { load(); }
        },
        refresh() {
            if (wanted) { controller?.refresh(); }
        },
    };
}
