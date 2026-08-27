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
 * The Mac app's name, as its own bundle says it: the app in `/Applications`,
 * the folder it keeps notes in, and the menu it hangs off the menu bar.
 *
 * The same string as PRODUCT_NAME, and a separate constant on purpose. Every
 * surface is called Birta Writer, so the two spellings have converged; what
 * has not converged is what they MEAN. This one names one program, and it
 * reaches the filesystem: `ScratchpadLocation` builds the note's own name out
 * of it. PRODUCT_NAME names the line. Collapsing them would make any future
 * divergence a rename of paths rather than of a label, and would leave the
 * settings row that names the app reading the constant for the suite.
 *
 * Because the two values are now equal, the drift test in
 * `shared/__tests__/editorCommandsContributions.test.ts` can no longer tell
 * them apart by value. It pins the STRUCTURE instead: which constant each
 * `folderName` branch reads, and that the note's name interpolates this one.
 *
 * Three surfaces carry the settings-title expansion as a literal (the command
 * table, package.nls.json and the NSWindow title in
 * `mac/Sources/BirtaWriter/SettingsWindow.swift`), and that same drift test holds
 * all three to this constant. The fourth, `e2e/macHost/checks.mjs`, is an
 * assertion rather than a declaration, so it fails on its own when the label
 * moves.
 */
export const MAC_APP_NAME = "Birta Writer";

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
