/**
 * webview/components/shortcutsHelp/loader.ts
 *
 * The eager-graph seam for the shortcuts overlay. The overlay itself
 * (`./index`, with its stylesheet in `./styles`) is a rarely-launched
 * cheatsheet, so it loads through a cached dynamic `import()` the first time
 * the command runs, never at launch: the `utils/katexLoader.ts` pattern.
 * Everything in the eager graph that can open the overlay (the command host
 * in `webview/index.ts`, the toolbar's settings menu) imports THIS module and
 * nothing from `./index`; a static import of `./index` anywhere on the launch
 * path puts the whole overlay back into the eager bundle, which
 * `pnpm perf:bundle` would show and `shortcutsHelp.test.ts` pins.
 */

type ShortcutsHelpModule = typeof import("./index");

let modulePromise: Promise<ShortcutsHelpModule> | null = null;

/** Load (and cache) the overlay module. */
export function loadShortcutsHelp(): Promise<ShortcutsHelpModule> {
    return (modulePromise ??= import("./index"));
}

/**
 * Open the overlay, or close it when it is already open (the toggle lives in
 * `./index`). Resolves once the toggle has run; a failed chunk load is
 * reported rather than thrown, so a command host can call this fire-and-forget.
 */
export function openShortcutsHelpLazy(): Promise<void> {
    return loadShortcutsHelp()
        .then((m) => m.openShortcutsHelp())
        .catch((e: unknown) => console.error("[birta] shortcuts overlay failed to load", e));
}
