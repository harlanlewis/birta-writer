/**
 * src/utils/linkResolver.ts
 *
 * Pure link-target resolution for the openFile flow: turns the path a
 * document links to into the absolute file it means, without requiring the
 * author to write editor-specific paths. Markdown written for a site
 * generator keeps working in the editor: `/write/uber` inside a Hugo
 * `content/` tree resolves to `content/write/uber/index.md`.
 *
 * The chain (first hit wins, resolution is click-time only):
 *   (a) document-relative — today's exact behavior, always first
 *   (b) leading `/` — the workspace root (VS Code's own convention for
 *       rooted markdown links)
 *   (c) ancestor walk — every ancestor directory of the document up to the
 *       workspace root as a candidate site root (Hugo/Jekyll/Astro content
 *       dirs), nearest first
 *   (d) suffix inference — each base tried as-is, then `.md`, `.markdown`,
 *       `/index.md`, `/_index.md` (trailing-slash links prefer index files)
 *   (e) fallback — suffix match over the cached workspace file index
 *
 * Steps (c)–(e) run only in smart mode. Non-smart mode is pure path math
 * with no existence checks: relative and `@/` exactly as before, leading `/`
 * as workspace-root-relative (the pre-existing filesystem-root bug stays
 * fixed in both modes).
 *
 * Pure by the linkTargetSuggestions.ts precedent: no `vscode` import; the
 * caller injects stat + file-index IO so everything is unit-testable.
 */
import * as path from "path";

export interface ResolverIo {
    /** true iff absPath exists and is a regular file */
    isFile(absPath: string): Promise<boolean>;
    /** absolute fsPaths of workspace files (the provider's cached findFiles) */
    getFileIndex(): Promise<readonly string[]>;
}

export interface ResolveContext {
    docFsPath: string;
    /** workspace folder containing the doc, or null when there is none */
    workspaceRootFsPath: string | null;
    smartLinks: boolean;
}

const MD_SUFFIXES = [".md", ".markdown"] as const;

function toPosix(p: string): string {
    return p.split(path.sep).join("/");
}

function safeDecode(p: string): string {
    try {
        return decodeURIComponent(p);
    } catch {
        return p;
    }
}

/** Ancestor dirs of `dir` up to and including `root` (nearest first). */
function ancestorsUpTo(dir: string, root: string): string[] {
    const out: string[] = [];
    let cur = dir;
    for (;;) {
        out.push(cur);
        if (cur === root) break;
        const parent = path.dirname(cur);
        if (parent === cur) break; // filesystem root; root wasn't an ancestor
        cur = parent;
    }
    return out;
}

/** Candidate files a link path may mean, in preference order. */
function withSuffixes(base: string, hadTrailingSlash: boolean): string[] {
    if (hadTrailingSlash) {
        // A dir-style link prefers the dir's index document.
        return [path.join(base, "index.md"), path.join(base, "_index.md"), base];
    }
    return [
        base,
        ...MD_SUFFIXES.map((s) => base + s),
        path.join(base, "index.md"),
        path.join(base, "_index.md"),
    ];
}

/**
 * Longest common directory-prefix length between two absolute paths —
 * the "closest to the document" tiebreak.
 */
function commonDirPrefixLen(a: string, b: string): number {
    const as = a.split(path.sep);
    const bs = b.split(path.sep);
    let i = 0;
    while (i < as.length && i < bs.length && as[i] === bs[i]) i++;
    return i;
}

/** Shortest path → closest to the document → stable alpha. */
function pickBest(matches: string[], docFsPath: string): string {
    return [...matches].sort((a, b) => {
        if (a.length !== b.length) return a.length - b.length;
        const ca = commonDirPrefixLen(a, docFsPath);
        const cb = commonDirPrefixLen(b, docFsPath);
        if (ca !== cb) return cb - ca;
        return a < b ? -1 : a > b ? 1 : 0;
    })[0];
}

/**
 * The tail of a link path that is meaningful for index matching: posix
 * separators, leading `/`, `./` and `../` segments dropped.
 */
function matchTail(p: string): string {
    const segs = toPosix(p).split("/").filter((s) => s !== "" && s !== ".");
    while (segs.length > 0 && segs[0] === "..") segs.shift();
    return segs.join("/");
}

/** Suffix match of `linkPath` (+ inferred suffixes) over the file index. */
async function resolveViaIndex(
    linkPath: string,
    ctx: ResolveContext,
    io: ResolverIo,
): Promise<string | null> {
    const tail = matchTail(linkPath).toLowerCase();
    if (!tail) return null;
    const variants = [
        tail,
        ...MD_SUFFIXES.map((s) => tail + s),
        tail + "/index.md",
        tail + "/_index.md",
    ];
    const matches: string[] = [];
    for (const fsPath of await io.getFileIndex()) {
        const posix = toPosix(fsPath).toLowerCase();
        for (const v of variants) {
            if (posix === v || posix.endsWith("/" + v)) {
                matches.push(fsPath);
                break;
            }
        }
    }
    if (matches.length === 0) return null;
    return pickBest(matches, ctx.docFsPath);
}

/**
 * Resolves a markdown link's path portion (fragment already split off by the
 * caller) to an absolute file path.
 *
 * Smart mode returns only paths verified to exist, or null (the caller
 * warns). Non-smart mode always returns the single computed path unchecked —
 * today's behavior, where a miss surfaces as VS Code's own open error.
 */
export async function resolveLinkPath(
    linkPath: string,
    ctx: ResolveContext,
    io: ResolverIo,
): Promise<string | null> {
    const docDir = path.dirname(ctx.docFsPath);
    const root = ctx.workspaceRootFsPath;

    if (!ctx.smartLinks) {
        if (linkPath.startsWith("@/")) {
            return root
                ? path.join(root, linkPath.slice(2))
                : path.resolve(docDir, "..", linkPath.slice(2));
        }
        if (linkPath.startsWith("/")) {
            // Workspace-root-relative (never the filesystem root).
            return root ? path.join(root, linkPath) : path.resolve(docDir, "." + linkPath);
        }
        return path.resolve(docDir, linkPath);
    }

    // Smart: try the raw bytes and the percent-decoded form (`foo%20bar.md`
    // usually means "foo bar.md", but a literally-named file still wins).
    const forms = [...new Set([linkPath, safeDecode(linkPath)])];
    const bases: string[] = [];
    for (const raw of forms) {
        const hadTrailingSlash = raw.length > 1 && raw.endsWith("/");
        const p = hadTrailingSlash ? raw.slice(0, -1) : raw;
        if (p.startsWith("@/")) {
            if (root) bases.push(...withSuffixes(path.join(root, p.slice(2)), hadTrailingSlash));
            else bases.push(...withSuffixes(path.resolve(docDir, "..", p.slice(2)), hadTrailingSlash));
        } else if (p.startsWith("/")) {
            const seen = new Set<string>();
            if (root) {
                // The ancestor walk exists to find site roots BETWEEN the doc
                // and the workspace root; a doc outside the workspace has no
                // such span — walking its real ancestors would escape to the
                // filesystem root (exactly the bug the resolver fixes).
                const docInRoot = docDir === root || docDir.startsWith(root + path.sep);
                const dirs = docInRoot ? [root, ...ancestorsUpTo(docDir, root)] : [root];
                for (const dir of dirs) {
                    const base = path.join(dir, p);
                    if (seen.has(base)) continue;
                    seen.add(base);
                    bases.push(...withSuffixes(base, hadTrailingSlash));
                }
            } else {
                bases.push(...withSuffixes(path.resolve(docDir, "." + p), hadTrailingSlash));
            }
        } else {
            bases.push(...withSuffixes(path.resolve(docDir, p), hadTrailingSlash));
        }
    }

    for (const cand of bases) {
        if (await io.isFile(cand)) return cand;
    }

    for (const raw of forms) {
        const hit = await resolveViaIndex(raw, ctx, io);
        if (hit) return hit;
    }
    return null;
}

/**
 * Resolves a wikilink target (heading already split off). Path-style targets
 * run the smart chain; bare names match by filename across the workspace —
 * case-insensitive, with or without the markdown extension, markdown files
 * preferred, shortest path then closest to the document as tiebreaks.
 * Smart mode only; non-smart callers route wikilink targets through
 * resolveLinkPath as plain relative paths.
 */
export async function resolveWikiTarget(
    target: string,
    ctx: ResolveContext,
    io: ResolverIo,
): Promise<string | null> {
    const trimmed = target.trim();
    if (!trimmed) return null;

    if (trimmed.includes("/")) {
        // Path-style target: the full smart chain already tries doc-relative,
        // root, ancestors, suffixes, and the index fallback.
        return resolveLinkPath(trimmed, ctx, io);
    }

    const lower = trimmed.toLowerCase();
    const mdMatches: string[] = [];
    const otherMatches: string[] = [];
    for (const fsPath of await io.getFileIndex()) {
        const base = path.basename(fsPath).toLowerCase();
        const ext = path.extname(base);
        const stem = ext ? base.slice(0, -ext.length) : base;
        if (base === lower || stem === lower) {
            if ((MD_SUFFIXES as readonly string[]).includes(ext)) mdMatches.push(fsPath);
            else otherMatches.push(fsPath);
        }
    }
    const pool = mdMatches.length > 0 ? mdMatches : otherMatches;
    if (pool.length === 0) return null;
    return pickBest(pool, ctx.docFsPath);
}
