/**
 * webview/export/loader.ts
 *
 * The eager-graph seam for Export as HTML (MAR-32). The exporter (`./index`)
 * walks every stylesheet and the whole rendered document, and it runs once
 * per export rather than once per launch, so it loads through a cached
 * dynamic `import()` the first time the command runs: the
 * `utils/katexLoader.ts` pattern. The command registry imports THIS module
 * and nothing from `./index`; a static import of `./index` anywhere on the
 * launch path puts the exporter into the eager bundle, which
 * `pnpm perf:bundle` would show and `htmlExport.test.ts` pins.
 */

type ExportModule = typeof import("./index");

let modulePromise: Promise<ExportModule> | null = null;

/** Load (and cache) the exporter module. */
export function loadHtmlExport(): Promise<ExportModule> {
    return (modulePromise ??= import("./index"));
}

/**
 * Export the live document as HTML. Resolves once the snapshot has been
 * handed to the host; a failed chunk load or a failed snapshot is reported
 * rather than thrown, so a command host can call this fire-and-forget.
 */
export function exportHtmlLazy(): Promise<void> {
    return loadHtmlExport()
        .then((m) => m.exportDocumentAsHtml())
        .catch((e: unknown) => console.error("[birta] HTML export failed", e));
}
