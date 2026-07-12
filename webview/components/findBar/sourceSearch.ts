/**
 * Source-based search engine for the find bar (MAR-8).
 *
 * Tier 1 — segment index: walks the ProseMirror document and flattens it into
 * searchable segments — visible text (with exact PM positions) plus node/mark
 * attributes such as link URLs, image src/alt/title and code-fence language.
 * Matches carry enough position data for the replace machinery to rewrite
 * them precisely.
 *
 * Tier 2 — raw-source fallback: runs the same query over the markdown source
 * and reports occurrences not already covered by tier 1 (pure syntax such as
 * `**`, heading markers, `---` or reference definitions). These map to a
 * top-level block for reveal only; they cannot be replaced.
 */
import type { Node as PmNode, Mark } from "@milkdown/prose/model";

// ── Query compilation ────────────────────────────────────

export interface QueryOptions {
    regex: boolean;
    wholeWord: boolean;
    caseSensitive: boolean;
}

/** Upper bound on pattern length: keeps pathological regexes out of the hot path. */
export const MAX_PATTERN_LENGTH = 1024;

export type QueryResult =
    | { re: RegExp; error?: undefined }
    | { re?: undefined; error: string };

/** Escape regex metacharacters so `s` matches itself as a pattern. */
export function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile the find-bar query into a global RegExp.
 * Non-regex input is escaped literally; whole-word wraps the pattern in
 * word boundaries; invalid regex input is reported instead of thrown.
 */
export function buildQuery(query: string, opts: QueryOptions): QueryResult {
    if (!query) {
        return { error: "Empty pattern" };
    }
    if (query.length > MAX_PATTERN_LENGTH) {
        return { error: "Pattern too long" };
    }
    let source = opts.regex ? query : escapeRegExp(query);
    if (opts.wholeWord) {
        source = `\\b(?:${source})\\b`;
    }
    try {
        return { re: new RegExp(source, opts.caseSensitive ? "g" : "gi") };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * Expand `$1…$99`, `$&` and `$$` in a regex-mode replacement template.
 * References to non-existent groups stay literal (matching VS Code);
 * non-participating groups expand to the empty string.
 */
export function expandReplacement(template: string, exec: RegExpExecArray): string {
    return template.replace(/\$(\$|&|\d\d?)/g, (whole, token: string) => {
        if (token === "$") {
            return "$";
        }
        if (token === "&") {
            return exec[0];
        }
        const n = Number(token);
        if (n >= exec.length && token.length === 2) {
            // Two-digit group missing: fall back to the one-digit group and
            // keep the extra digit literal (e.g. "$12" with 1 group → "<g1>2")
            const first = Number(token[0]);
            if (first > 0 && first < exec.length) {
                return (exec[first] ?? "") + token[1];
            }
            return whole;
        }
        if (n === 0 || n >= exec.length) {
            return whole;
        }
        return exec[n] ?? "";
    });
}

// ── Segments (tier 1) ────────────────────────────────────

export interface TextSegment {
    kind: "text";
    /** PM position of the first character of the text node. */
    from: number;
    text: string;
}

export interface NodeAttrSegment {
    kind: "node-attr";
    nodePos: number;
    attr: string;
    text: string;
}

export interface MarkAttrSegment {
    kind: "mark-attr";
    /** PM range of the text carrying the mark (adjacent runs coalesced). */
    from: number;
    to: number;
    mark: Mark;
    attr: string;
    text: string;
}

export type Segment = TextSegment | NodeAttrSegment | MarkAttrSegment;

/**
 * Flatten the document into searchable segments: every text node plus the
 * searchable attributes (link `href`, image `src`/`alt`/`title`, code block
 * `language`). Adjacent text nodes sharing one link mark are coalesced into
 * a single href segment so a link reports one match, not one per styled run.
 */
export function collectSegments(doc: PmNode): Segment[] {
    const segments: Segment[] = [];
    let openLink: MarkAttrSegment | null = null;
    doc.descendants((node, pos) => {
        if (node.isText && node.text) {
            segments.push({ kind: "text", from: pos, text: node.text });
            const link = node.marks.find((m) => m.type.name === "link");
            const href = link?.attrs["href"];
            if (link && typeof href === "string" && href) {
                if (openLink && openLink.to === pos && openLink.mark.eq(link)) {
                    openLink.to = pos + node.text.length;
                } else {
                    openLink = {
                        kind: "mark-attr",
                        from: pos,
                        to: pos + node.text.length,
                        mark: link,
                        attr: "href",
                        text: href,
                    };
                    segments.push(openLink);
                }
            } else {
                openLink = null;
            }
            return;
        }
        openLink = null;
        const name = node.type.name;
        if (name === "image") {
            for (const attr of ["src", "alt", "title"]) {
                const value = node.attrs[attr];
                if (typeof value === "string" && value) {
                    segments.push({ kind: "node-attr", nodePos: pos, attr, text: value });
                }
            }
        } else if (name === "code_block") {
            const language = node.attrs["language"];
            if (typeof language === "string" && language) {
                segments.push({ kind: "node-attr", nodePos: pos, attr: "language", text: language });
            }
        }
        return undefined;
    });
    return segments;
}

// ── Matches ──────────────────────────────────────────────

export interface TextMatch {
    kind: "text";
    from: number;
    to: number;
    exec: RegExpExecArray;
}

export interface NodeAttrMatch {
    kind: "node-attr";
    nodePos: number;
    attr: string;
    /** Offsets of the hit inside the attribute string. */
    start: number;
    end: number;
    exec: RegExpExecArray;
}

export interface MarkAttrMatch {
    kind: "mark-attr";
    from: number;
    to: number;
    mark: Mark;
    attr: string;
    start: number;
    end: number;
    exec: RegExpExecArray;
}

export interface BlockMatch {
    kind: "block";
    /** Index of the top-level block the source hit falls in. */
    blockIndex: number;
    /** PM position of that block's start (for document-order sorting). */
    blockPos: number;
    /** 1-indexed source line of the hit. */
    line: number;
}

export type SegmentMatch = TextMatch | NodeAttrMatch | MarkAttrMatch;
export type SearchMatch = SegmentMatch | BlockMatch;

/** Iterate all non-empty matches; empty matches are skipped to avoid infinite loops. */
function* execAll(re: RegExp, text: string): Generator<RegExpExecArray> {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        if (m[0] === "") {
            re.lastIndex++;
            continue;
        }
        yield m;
    }
}

/** Run the compiled query over every segment. */
export function searchSegments(segments: Segment[], re: RegExp): SegmentMatch[] {
    const out: SegmentMatch[] = [];
    for (const seg of segments) {
        for (const m of execAll(re, seg.text)) {
            if (seg.kind === "text") {
                out.push({
                    kind: "text",
                    from: seg.from + m.index,
                    to: seg.from + m.index + m[0].length,
                    exec: m,
                });
            } else if (seg.kind === "node-attr") {
                out.push({
                    kind: "node-attr",
                    nodePos: seg.nodePos,
                    attr: seg.attr,
                    start: m.index,
                    end: m.index + m[0].length,
                    exec: m,
                });
            } else {
                out.push({
                    kind: "mark-attr",
                    from: seg.from,
                    to: seg.to,
                    mark: seg.mark,
                    attr: seg.attr,
                    start: m.index,
                    end: m.index + m[0].length,
                    exec: m,
                });
            }
        }
    }
    return out;
}

// ── Raw-source fallback (tier 2) ─────────────────────────

/** Map a 1-indexed source line to its block index via binary search over lineMap. */
export function lineToBlockIndex(lineMap: number[], line: number): number {
    let lo = 0;
    let hi = lineMap.length - 1;
    let ans = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lineMap[mid] <= line) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}

/** PM start offsets of every top-level block, in one cumulative pass. */
export function computeBlockPositions(doc: PmNode): number[] {
    const positions: number[] = [];
    doc.forEach((_child, offset) => {
        positions.push(offset);
    });
    return positions;
}

/** Map a PM position to the index of the top-level block containing it. */
function posToBlockIndex(blockPositions: number[], pos: number): number {
    let lo = 0;
    let hi = blockPositions.length - 1;
    let ans = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (blockPositions[mid] <= pos) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}

/**
 * Run the query over the raw markdown source and keep only occurrences not
 * already represented by a tier-1 match. Coverage is tracked as a multiset of
 * matched strings per block (falling back to a global multiset when the
 * block mapping disagrees), so only pure-syntax hits survive.
 */
export function searchSourceFallback(
    source: string,
    lineMap: number[],
    re: RegExp,
    covered: SegmentMatch[],
    blockPositions: number[],
): BlockMatch[] {
    if (!source) {
        return [];
    }

    const perBlock = new Map<number, Map<string, number>>();
    const global = new Map<string, number>();
    for (const m of covered) {
        const pos = m.kind === "node-attr" ? m.nodePos : m.from;
        const blockIdx = posToBlockIndex(blockPositions, pos);
        let bucket = perBlock.get(blockIdx);
        if (!bucket) {
            bucket = new Map();
            perBlock.set(blockIdx, bucket);
        }
        const text = m.exec[0];
        bucket.set(text, (bucket.get(text) ?? 0) + 1);
        global.set(text, (global.get(text) ?? 0) + 1);
    }

    // Line start offsets for offset → line mapping
    const lineStarts: number[] = [0];
    for (let i = 0; i < source.length; i++) {
        if (source[i] === "\n") {
            lineStarts.push(i + 1);
        }
    }
    const offsetToLine = (offset: number): number => {
        let lo = 0;
        let hi = lineStarts.length - 1;
        let ans = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (lineStarts[mid] <= offset) {
                ans = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return ans + 1;
    };

    const out: BlockMatch[] = [];
    for (const m of execAll(re, source)) {
        const text = m[0];
        const line = offsetToLine(m.index);
        const blockIdx = lineToBlockIndex(lineMap, line);
        const bucket = perBlock.get(blockIdx);
        const inBlock = bucket?.get(text) ?? 0;
        if (inBlock > 0) {
            bucket!.set(text, inBlock - 1);
            global.set(text, (global.get(text) ?? 1) - 1);
            continue;
        }
        // Block mapping can disagree with the doc's block layout (e.g. a
        // heading and its following paragraph share one lineMap entry);
        // consume from the global multiset before declaring a syntax hit.
        const inGlobal = global.get(text) ?? 0;
        if (inGlobal > 0) {
            global.set(text, inGlobal - 1);
            continue;
        }
        out.push({
            kind: "block",
            blockIndex: blockIdx,
            blockPos: blockPositions[Math.min(blockIdx, Math.max(0, blockPositions.length - 1))] ?? 0,
            line,
        });
    }
    return out;
}
