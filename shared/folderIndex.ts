/**
 * shared/folderIndex.ts
 *
 * The folder edge index (MAR-467): which notes in a folder name which, as a
 * host hands it to the page. The host walks the folder, reads each note once
 * (shared/noteLinks.ts), resolves every reference with the same resolver a
 * click uses, and sends the result; the page never reads a file and never
 * resolves a path. What crosses the wire is edges, never bytes.
 *
 * Every path is ROOT-RELATIVE and POSIX-separated, like the file explorer's
 * wire (`ProjectEntry` in shared/messages.ts), so the page can compare two
 * of them and join nothing.
 */

import type { NoteLinkKind } from "./noteLinks";
import type { OkfStatus, OkfTrust } from "./okf";

/** One note in the folder, with what a view shows of it. */
export interface FolderNode {
    /** Root-relative POSIX path: the note's identity everywhere in the index. */
    path: string;
    /** Frontmatter `title`, else the file name without its extension. */
    name: string;
    /** OKF `type`, null when the note carries none. */
    type: string | null;
    tags: string[];
    status: OkfStatus | null;
    trust: OkfTrust | null;
    staleAfter: string | null;
}

/** One reference from a note to another, directed from the note that names it. */
export interface FolderEdge {
    /** The naming note's path. */
    from: string;
    /**
     * The note it resolves to, or null when it resolves to none: no such file,
     * a file outside the root, or a note past the walk's cap. An unresolved
     * reference is kept rather than dropped (the OKF rule: a broken cross-link
     * is not malformed), so a view can draw it dangling.
     */
    to: string | null;
    /** What the reference names, as written: the path portion, or a wikilink's target. */
    target: string;
    kind: NoteLinkKind;
    /** The reference's own text in the naming note. */
    text: string;
    /** 1-based line of the naming note the reference is written on. */
    line: number;
}

export interface FolderIndex {
    /** The folder's own name, as a header says it. */
    rootName: string;
    nodes: FolderNode[];
    edges: FolderEdge[];
    /**
     * The walk stopped at its cap before it ran out of notes, so an absence
     * can mean "not reached" rather than "not linked". A view has to say so.
     */
    truncated: boolean;
}

/**
 * The references that point AT `self`, in the order the index holds them. A
 * note naming itself is not a backlink.
 */
export function backlinksOf(index: FolderIndex, self: string): FolderEdge[] {
    return index.edges.filter((e) => e.to === self && e.from !== self);
}

/**
 * The POSIX path from the directory holding `fromNote` to `toNote`, both
 * root-relative. What the page hands a host's `openFile`, which resolves a
 * path relative to the open document first.
 */
export function relativeNotePath(fromNote: string, toNote: string): string {
    const fromDir = fromNote.split("/").slice(0, -1);
    const to = toNote.split("/");
    let shared = 0;
    while (shared < fromDir.length && shared < to.length - 1 && fromDir[shared] === to[shared]) { shared++; }
    const up = fromDir.length - shared;
    const rel = [...new Array<string>(up).fill(".."), ...to.slice(shared)].join("/");
    return up === 0 ? `./${rel}` : rel;
}
