/**
 * Re-export of the shared GitHub-compatible slugifier (shared/slug.ts).
 * The implementation moved to shared/ so the extension host can compute the
 * same heading slugs the webview renders (cross-file `#heading` navigation
 * must agree with in-page anchors byte-for-byte). Webview imports keep this
 * path.
 */
export { slugify, slugifyHeadings } from "../../shared/slug";
