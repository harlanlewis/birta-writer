/**
 * src/folderIndex.ts
 *
 * VS Code's producer of the folder edge index (shared/folderIndex.ts): walk a
 * workspace folder's notes, read each one's references (shared/noteLinks.ts),
 * and resolve every reference with the resolver a click on it uses
 * (utils/linkResolver.ts), so a backlink and the file a click opens can never
 * disagree about which note a link means.
 *
 * Pure by the linkResolver precedent: no `vscode` import. The provider lends
 * the IO (the walk, a file's text, the workspace file index) and owns the
 * wiring (who asked, what changed on disk).
 *
 * The work is cached at two grains, because they go stale for different
 * reasons. A note's READING (its references and attributes) changes only when
 * that file does, so a save re-reads one file. A reference's RESOLUTION
 * depends on which files exist and on nothing a save can change, so it is
 * kept until a file is created or deleted; a save then resolves only the
 * references the saved note wrote anew. Resolution is in-memory work over the
 * file list, never a disk read, which is why `isFile` is answered from that
 * list rather than by a stat.
 *
 * The one divergence that choice buys: a target missing from the provider's
 * workspace file index (excluded by `files.exclude`, or past that index's
 * own cap) reads here as unresolved, although a click would stat it and open
 * it. The index errs toward a dangling edge, never toward a wrong one.
 */
import * as path from "path";
import { DOCUMENT_EXTENSIONS } from "../shared/documentExtensions";
import type { FolderEdge, FolderIndex, FolderNode } from "../shared/folderIndex";
import { readNote, type NoteReading } from "../shared/noteLinks";
import { resolveLinkPath, resolveWikiTarget, type ResolverIo } from "./utils/linkResolver";

/**
 * How many notes one walk reads before it stops and says it stopped. Enough
 * for a working vault; a folder past it is indexed partially and the index
 * carries `truncated`, so no view reads the cut as an absence of links.
 */
export const FOLDER_INDEX_CAP = 2000;

/** What the provider lends: everything that touches the disk or the editor. */
export interface FolderIndexIo {
    /** Up to `limit` note files (absolute fsPaths) under `root`, any order. */
    listNotes(root: string, limit: number): Promise<readonly string[]>;
    /** A note's text, or null when it cannot be read. */
    readText(fsPath: string): Promise<string | null>;
    /** Every file in the workspace (absolute fsPaths): what a reference resolves against. */
    fileIndex(): Promise<readonly string[]>;
    /** `birta.smartLinks` for documents under `root`. */
    smartLinks(root: string): boolean;
    /** Let the host's event loop run; called between batches of resolutions. */
    yieldToHost?(): Promise<void>;
}

/** How many fresh resolutions run between two yields to the host. */
const RESOLVE_BATCH = 200;

const NOTE_EXT = new Set(DOCUMENT_EXTENSIONS.map((e) => `.${e}`));

/** The walk's glob: every file this editor opens is a note. */
export const NOTE_GLOB = `**/*.{${DOCUMENT_EXTENSIONS.join(",")}}`;

/** Is this a file the index reads as a note? */
export function isNotePath(fsPath: string): boolean {
    return NOTE_EXT.has(path.extname(fsPath).toLowerCase());
}

function toPosix(p: string): string {
    return p.split(path.sep).join("/");
}

/** `abs` relative to `root` in POSIX form, or null when it is not under `root`. */
function underRoot(root: string, abs: string): string | null {
    const rel = path.relative(root, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) { return null; }
    return toPosix(rel);
}

interface RootState {
    /** The walk's note list, sorted; null until walked, dropped when the file set changes. */
    notes: string[] | null;
    truncated: boolean;
    /** Readings per note fsPath; an entry is dropped when its file changes. */
    readings: Map<string, NoteReading | null>;
    /** Resolved targets by (kind, naming directory, target, smartLinks); dropped when the file set changes. */
    resolutions: Map<string, string | null>;
    /** The last assembled index; dropped on any change under the root. */
    index: FolderIndex | null;
    /** In-flight assembly, so two asks at once build once. */
    building: Promise<FolderIndex> | null;
}

export class FolderIndexer {
    private readonly roots = new Map<string, RootState>();

    constructor(private readonly io: FolderIndexIo) {}

    private state(root: string): RootState {
        let s = this.roots.get(root);
        if (!s) {
            s = { notes: null, truncated: false, readings: new Map(), resolutions: new Map(), index: null, building: null };
            this.roots.set(root, s);
        }
        return s;
    }

    /** The roots holding `fsPath`, among those indexed so far. */
    private rootsOf(fsPath: string): RootState[] {
        const out: RootState[] = [];
        for (const [root, s] of this.roots) {
            if (underRoot(root, fsPath) !== null) { out.push(s); }
        }
        return out;
    }

    /**
     * A file under an indexed root was written. Only that note's reading is
     * stale: a write changes which references a note makes, never which files
     * exist, so every resolution already made still holds. Returns whether
     * anything indexed changed, so the caller knows to re-send.
     */
    fileChanged(fsPath: string): boolean {
        if (!isNotePath(fsPath)) { return false; }
        let touched = false;
        for (const s of this.rootsOf(fsPath)) {
            s.readings.delete(fsPath);
            s.index = null;
            touched = true;
        }
        return touched;
    }

    /**
     * A file was created or deleted (what a rename fires too). A root holding
     * it walks again. Its resolutions go too, for any file: a dangling link can
     * have been waiting for exactly that one. A NOTE created or deleted
     * anywhere clears every root's resolutions, because a wikilink resolves
     * against the whole workspace's files and the nearest match can move to
     * another folder.
     */
    fileSetChanged(fsPath: string): boolean {
        let touched = false;
        for (const s of this.rootsOf(fsPath)) {
            s.notes = null;
            s.resolutions.clear();
            s.readings.delete(fsPath);
            s.index = null;
            touched = true;
        }
        if (isNotePath(fsPath)) {
            for (const s of this.roots.values()) {
                if (s.resolutions.size === 0 && s.index === null) { continue; }
                s.resolutions.clear();
                s.index = null;
                touched = true;
            }
        }
        return touched;
    }

    /** The index of `root`, assembled from what is cached and reading only what is not. */
    async indexFor(root: string): Promise<FolderIndex> {
        const s = this.state(root);
        if (s.index) { return s.index; }
        if (s.building) { return s.building; }
        const build = this.assemble(root, s).finally(() => { s.building = null; });
        s.building = build;
        return build;
    }

    private async assemble(root: string, s: RootState): Promise<FolderIndex> {
        if (!s.notes) {
            // One past the cap, so a folder holding exactly the cap is not called truncated.
            const listed = await this.io.listNotes(root, FOLDER_INDEX_CAP + 1);
            const notes = listed.filter(isNotePath).sort();
            s.truncated = notes.length > FOLDER_INDEX_CAP;
            s.notes = notes.slice(0, FOLDER_INDEX_CAP);
        }
        const notes = s.notes;
        await Promise.all(notes.map(async (fsPath) => {
            if (s.readings.has(fsPath)) { return; }
            const text = await this.io.readText(fsPath);
            s.readings.set(fsPath, text === null ? null : readNote(text));
        }));

        // Every note the walk listed exists, whether or not the workspace file
        // index (capped on its own) reached it, so both answer `isFile`.
        const files = [...new Set([...await this.io.fileIndex(), ...notes])];
        const fileSet = new Set(files);
        const resolverIo: ResolverIo = {
            isFile: async (abs) => fileSet.has(abs),
            getFileIndex: async () => files,
        };
        const smartLinks = this.io.smartLinks(root);
        const nodePaths = new Set(notes.map((n) => underRoot(root, n)!));

        // A wikilink resolves by name against the whole folder, so the same
        // name from the same directory always lands on the same note: memoize
        // per directory rather than walking the file list once per link, and
        // keep the answers across assemblies until the file set changes.
        const memo = s.resolutions;
        let resolvedFresh = 0;
        const resolve = async (docFsPath: string, target: string, wiki: boolean): Promise<string | null> => {
            const key = `${wiki ? "w" : "l"}\u0000${smartLinks ? 1 : 0}\u0000${path.dirname(docFsPath)}\u0000${target}`;
            if (memo.has(key)) { return memo.get(key)!; }
            // A cold folder can hold thousands of references; hand the host
            // back its thread between batches rather than holding it for the
            // whole folder.
            if (++resolvedFresh % RESOLVE_BATCH === 0) { await this.io.yieldToHost?.(); }
            const ctx = { docFsPath, workspaceRootFsPath: root, smartLinks };
            const abs = wiki && smartLinks
                ? await resolveWikiTarget(target, ctx, resolverIo)
                : await resolveLinkPath(target, ctx, resolverIo);
            memo.set(key, abs);
            return abs;
        };

        const nodes: FolderNode[] = [];
        const edges: FolderEdge[] = [];
        for (const fsPath of notes) {
            const rel = underRoot(root, fsPath)!;
            const reading = s.readings.get(fsPath) ?? null;
            const stem = path.basename(fsPath, path.extname(fsPath));
            const meta = reading?.meta;
            nodes.push({
                path: rel,
                name: meta?.title ?? stem,
                type: meta?.type ?? null,
                tags: meta?.tags ?? [],
                status: meta?.status ?? null,
                trust: meta?.trust ?? null,
                staleAfter: meta?.staleAfter ?? null,
            });
            for (const link of reading?.links ?? []) {
                if (link.path === "") { continue; }
                const abs = await resolve(fsPath, link.path, link.kind === "wiki");
                const inRoot = abs === null ? null : underRoot(root, abs);
                // A reference that resolves to a file which is not a note (an
                // image, a PDF) is not a relation between notes: it is left out
                // rather than drawn as a dangling note.
                if (inRoot !== null && !isNotePath(abs!)) { continue; }
                edges.push({
                    from: rel,
                    to: inRoot !== null && nodePaths.has(inRoot) ? inRoot : null,
                    target: link.path,
                    kind: link.kind,
                    text: link.text,
                    line: link.line,
                });
            }
        }
        const index: FolderIndex = { rootName: path.basename(root), nodes, edges, truncated: s.truncated };
        s.index = index;
        return index;
    }

    /** `fsPath` as the index names it under `root`, or null when the index does not hold it. */
    selfIn(root: string, fsPath: string, index: FolderIndex): string | null {
        const rel = underRoot(root, fsPath);
        return rel !== null && index.nodes.some((n) => n.path === rel) ? rel : null;
    }
}
