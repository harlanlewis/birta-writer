/**
 * The file extensions the editor treats as images when it lists files: the
 * path completer's thumbnails and the project image picker. One list, so the
 * hosts and the page agree on what counts.
 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".bmp", ".tiff", ".ico",
]);

/** Whether `path` names an image by its extension, case-insensitively. */
export function isImagePath(path: string): boolean {
    const dot = path.lastIndexOf(".");
    if (dot < 0 || dot < path.lastIndexOf("/")) { return false; }
    return IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}
