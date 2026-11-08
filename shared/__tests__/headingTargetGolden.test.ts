/**
 * The golden file that holds Birta Writer for Mac's port of the heading
 * resolver to the TypeScript it ports.
 *
 * `shared/headingTarget.ts` decides which line a place-name means, over
 * `shared/headingScan.ts` and `shared/slug.ts`. `bwr <file> --at <target>`
 * resolves the same names in Swift (`HeadingTarget.swift` in
 * mac/Sources/BirtaWriterCore), which cannot import them, so this records what
 * the TypeScript answers over the corpus and a set of edge shapes, and the
 * Swift suite (`HeadingTargetGoldenTests`) requires the port to answer the
 * same, input for input. The recording is regenerated in memory on every run,
 * so the file can never quietly describe an older resolver.
 *
 * To rewrite the file after an intended change to any of the three modules:
 *
 *     BIRTA_WRITE_GOLDEN=1 pnpm exec vitest run shared/__tests__/headingTargetGolden.test.ts
 *
 * then run `bash mac/scripts/test.sh --filter Golden`, which is what says
 * whether the Swift still agrees.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { scanHeadings } from "../headingScan";
import { slugify } from "../slug";
import { documentLineCount, findHeadingLine, parseAtTarget, renderedHeadingText } from "../headingTarget";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GOLDEN_PATH = path.join(__dirname, "fixtures", "headingTargetGolden.json");

/** Every Markdown document under a directory, recursively, by repo-relative name. */
function documentsUnder(rel: string): Array<{ name: string; content: string }> {
    const out: Array<{ name: string; content: string }> = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(abs); continue; }
            if (/\.(md|markdown|mdx)$/i.test(entry.name)) {
                out.push({ name: path.relative(REPO_ROOT, abs).split(path.sep).join("/"), content: fs.readFileSync(abs, "utf8") });
            }
        }
    };
    walk(path.join(REPO_ROOT, rel));
    return out;
}

/**
 * The shapes the corpus holds few of and a port has most room to get wrong:
 * the frontmatter dialects, unclosed and nested fences, setext against a
 * thematic break, closing hash runs, indented headings, CRLF, and slugs over
 * scripts, digits and symbols that JavaScript's Unicode classes decide.
 */
const EXTRA: readonly string[] = [
    "---\ntitle: x\n---\n# After YAML\n",
    "+++\ntitle = 'x'\n+++\n# After TOML\n",
    "---\nunclosed: yes\n# Inside an unclosed block\n",
    "---\ntitle: x\n...\n# After the end marker\n",
    "```\n# fenced\n```\n# Out\n````\n```\n# still fenced\n````\n# Out again\n",
    "~~~\n# tilde\n```\n~~~\n# After tilde\n",
    "```\n# never closed\n",
    "Setext One\n===\n\nSetext Two\n---\n\n    indented code\n---\n\n---\n",
    "# Closed ##\n## Closed with space ## \n### Not # closed#\n#### #\n",
    "   # Three spaces\n    # Four spaces\n#NoSpace\n####### Seven\n",
    "# CRLF heading\r\n\r\n## Second\r\n",
    "# Café crème\n# Ünïcödé\n# 日本語の見出し\n# Ελληνικά\n# Кириллица\n",
    "# 🚀 Emoji lead\n# 🚀\n# !!!\n# A & B: C/D\n# under_score-hyphen\n# tab\there\n",
    "# Dup\n# Dup\n# Dup\n# dup\n# Dup 1\n# Dup-1\n",
    "# `code` heading\n# [link](https://x.test) heading\n# ![img](i.png) heading\n# [ref][r] heading\n",
    "# 42\n# 2026 plan\n# Iİıi\n# ß straße\n# ½ ² ٣ Ⅻ\n# ΟΔΟΣ ΣΑΣ\n# AΣ. ΑΣ1 Σ\n# ǅ title case\n",
    "# Trailing spaces   \n#   Leading spaces\n# \n#\n",
    "",
    "no headings at all\n",
    "last line without newline",
    "\uFEFF# Title after a byte-order mark\n",
];

/** The place-names asked of each document, derived from its own headings plus misses. */
function fragmentsFor(content: string): string[] {
    const out = new Set<string>(["nowhere-at-all", "", "%zz", "%20"]);
    const seen = new Map<string, number>();
    for (const h of scanHeadings(content)) {
        out.add(h.text);
        out.add(h.text.toUpperCase());
        const base = slugify(renderedHeadingText(h.text));
        out.add(base);
        out.add(encodeURIComponent(h.text));
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        out.add(`${base}-${n}`);
        out.add(`${base}-${n + 1}`);
    }
    return [...out];
}

/** Words as a shell types them after `--at`. */
const AT_WORDS: readonly string[] = [
    "1", "42", "L42", "l42", "0", "L0", "00", "007", "L", "#", "", " ", "  12  ", "#42", "42a", "L42a", "-3",
    "Getting Started", "#getting-started", "##double", "9007199254740993",
    "# Getting Started", "## Install ", "###### Six", "####### Seven", "#\tTabbed", "## 42", "## ", "# # Nested",
];

function generate(): unknown {
    const inputs = [
        ...documentsUnder("webview/__tests__/fixtures"),
        ...documentsUnder("samples"),
        ...EXTRA.map((content, i) => ({ name: `EXTRA[${i}]`, content })),
    ];
    return {
        documents: inputs.map(({ name, content }) => ({
            name,
            content,
            lineCount: documentLineCount(content),
            headings: scanHeadings(content),
            cases: fragmentsFor(content).map((fragment) => ({ fragment, line: findHeadingLine(content, fragment) ?? null })),
        })),
        slugs: [...new Set(inputs.flatMap(({ content }) => scanHeadings(content).map((h) => h.text)))]
            .map((text) => ({ text, rendered: renderedHeadingText(text), slug: slugify(renderedHeadingText(text)) })),
        words: AT_WORDS.map((word) => ({ word, target: parseAtTarget(word) })),
    };
}

describe("the heading-target golden file", () => {
    it("should be what the TypeScript answers today", () => {
        const fresh = generate();
        if (process.env.BIRTA_WRITE_GOLDEN === "1") {
            fs.writeFileSync(GOLDEN_PATH, JSON.stringify(fresh, null, 1) + "\n");
        }
        const onDisk: unknown = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
        expect(onDisk, "the golden is stale: rewrite it (see this file's header) and run the Swift suite").toEqual(fresh);
    });

    it("should reach enough headings, hits and misses to mean something", () => {
        const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8")) as {
            documents: Array<{ headings: unknown[]; cases: Array<{ line: number | null }> }>;
            slugs: Array<{ slug: string }>;
            words: Array<{ target: { kind: string } | null }>;
        };
        // A golden that recorded nothing would be matched by a port that finds
        // nothing, so its own reach is asserted.
        expect(golden.documents.length).toBeGreaterThanOrEqual(50 + EXTRA.length);
        expect(golden.documents.flatMap((d) => d.headings).length).toBeGreaterThanOrEqual(200);
        const cases = golden.documents.flatMap((d) => d.cases);
        expect(cases.filter((c) => c.line !== null).length).toBeGreaterThanOrEqual(700);
        expect(cases.filter((c) => c.line === null).length).toBeGreaterThanOrEqual(500);
        expect(golden.slugs.filter((s) => s.slug === "").length).toBeGreaterThanOrEqual(2);
        expect(golden.slugs.filter((s) => /[^\x00-\x7f]/.test(s.slug)).length).toBeGreaterThanOrEqual(5);
        expect(golden.words.filter((w) => w.target?.kind === "line").length).toBeGreaterThanOrEqual(5);
        expect(golden.words.filter((w) => w.target?.kind === "heading").length).toBeGreaterThanOrEqual(5);
        expect(golden.words.filter((w) => w.target === null).length).toBeGreaterThanOrEqual(4);
    });
});
