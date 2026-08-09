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
