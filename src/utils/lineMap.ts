/**
 * Re-export of the shared line-map implementation.
 * The logic lives in shared/lineMap.ts so the webview can recompute the map
 * locally; this shim keeps existing extension-side imports (and the vitest
 * coverage include path) stable.
 */
export { computeLineMap } from "../../shared/lineMap";
