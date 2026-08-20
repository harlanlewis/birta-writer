/**
 * The product name, as the UI says it.
 *
 * package.json's `displayName` is a marketplace listing title and carries a
 * descriptive suffix, so it is not what a menu row should interpolate: a
 * settings row reading "<product> - Rich Markdown Editor Settings" is a
 * sentence, not a label. This constant is the single source for any surface
 * that names the product, and a drift test in
 * `shared/__tests__/editorCommandsContributions.test.ts` requires
 * `displayName` to start with it, so a real rename cannot pass while a
 * marketing suffix can.
 */
export const PRODUCT_NAME = "Birta Writer";

/**
 * Jot's name, as its own bundle says it: the app in `/Applications`, the
 * folder it keeps notes in, and the menu it hangs off the menu bar.
 *
 * Separate from PRODUCT_NAME because the settings row that names Jot names a
 * different program from the one that names the extension, and both expand
 * through SETTINGS_TITLE_TEMPLATE. Three surfaces carry that expansion as a
 * literal (the command table, package.nls.json and the NSWindow title in
 * `jot/Sources/BirtaJot/SettingsWindow.swift`), and the drift test in
 * `shared/__tests__/editorCommandsContributions.test.ts` holds all three to
 * this constant. The fourth, `e2e/jotHost/checks.mjs`, is an assertion rather
 * than a declaration, so it fails on its own when the label moves.
 */
export const JOT_PRODUCT_NAME = "Birta Writer Jot";

/**
 * The published release history, opened by the gear menu's What's New row.
 *
 * Rung 0b of the network posture (`docs/NETWORK_POSTURE.md`): nothing is
 * fetched. The webview hands this string to the host, which scheme-checks it
 * and calls `env.openExternal`, so the request belongs to the user's browser
 * and `birta.network.enabled` has no say in it.
 *
 * It must keep naming the same repository as package.json's `repository.url`,
 * which is what `shared/__tests__/releasesUrl.test.ts` checks: a repository
 * move that updates the manifest and not this constant would leave the row
 * pointing at a repository we no longer publish from.
 */
export const RELEASES_URL = "https://github.com/harlanlewis/birta-writer/releases";
