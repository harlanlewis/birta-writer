/**
 * The golden file that holds Birta Writer for Mac's port of the note scanner
 * and the link resolver to the TypeScript they port.
 *
 * `shared/noteLinks.ts` reads a note's references from its source bytes, and
 * `src/utils/linkResolver.ts` decides which file each one means. The Mac app
 * builds the same folder index with neither (Swift cannot import them), so it
 * carries ports: `NoteLinks.swift` and `NoteLinkResolver.swift` in
 * mac/Sources/BirtaWriterCore. Hand-mirrored cases would hold the two together
 * only on the cases somebody thought to mirror, so instead this file records
 * what the TypeScript answers over a wide set of inputs, and the Swift suite
 * (`NoteLinksGoldenTests`) requires the port to answer the same, input for
 * input.
 *
 * The chain is editor, then TypeScript, then Swift. The corpus oracle
 * (webview/__tests__/noteLinksCorpus.test.ts) holds the TypeScript scanner to
 * the editor's own Links scan; this holds the recorded answers to the
 * TypeScript, and the recording is regenerated in memory on every run, so the
 * file can never quietly describe an older scanner. Change either side's
 * patterns alone and one of the two suites goes red: the TypeScript here, as a
 * stale golden, and the Swift there, as a disagreement.
 *
 * To rewrite the file after an intended change to either TypeScript module:
 *
 *     BIRTA_WRITE_GOLDEN=1 pnpm exec vitest run shared/__tests__/noteLinksGolden.test.ts
 *
 * then run `bash mac/scripts/test.sh --filter Golden`, which is what says
 * whether the Swift still agrees.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import ts from "typescript";
import { readNote } from "../noteLinks";
import { resolveLinkPath, resolveWikiTarget, type ResolverIo } from "../../src/utils/linkResolver";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GOLDEN_PATH = path.join(__dirname, "fixtures", "noteLinksGolden.json");
const CORPUS_TEST = "webview/__tests__/noteLinksCorpus.test.ts";

/**
 * The contexts the corpus oracle already judges against the editor, read out
 * of that file rather than copied, so a context added there is recorded here
 * the same day.
 */
function corpusContexts(): string[] {
    const file = path.join(REPO_ROOT, CORPUS_TEST);
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    let found: string[] | null = null;
    const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "CONTEXTS"
            && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
            found = node.initializer.elements.map((el) => {
                if (!ts.isStringLiteralLike(el)) { throw new Error(`a CONTEXTS entry in ${CORPUS_TEST} is not a string literal`); }
                return el.text;
            });
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (found === null) { throw new Error(`no \`const CONTEXTS = [...]\` in ${CORPUS_TEST}; this golden must follow it`); }
    return found;
}

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
 * The shapes the corpus holds few of and the port has most room to get wrong:
 * frontmatter the table parser accepts and refuses (a refusal drops the title,
 * the type and every `sources` edge at once), the OKF provenance fields,
 * whitespace JavaScript's `\s` counts and a naive port would not, and the block
 * and inline edges the scanner's regular expressions encode.
 */
const EXTRA: readonly string[] = [
    "---\ntitle: \"Quoted: Title\"\ntype: concept\ntags: [a, \"b c\", 'd']\n---\nBody [x](x.md)\n",
    "---\ntitle: Plain\ntags:\n  - one\n  - \"two\"\n---\n\n[[One]]\n",
    "---\ntags:\n[\n  alpha,\n  \"beta\",\n]\n---\n[a](a.md)\n",
    "---\ntags:\n[\n  alpha,\n  beta\n]\n---\n[a](a.md)\n",
    "---\ntags:\n[\n  alpha\n  beta,\n]\n---\n[refused by its commas](a.md)\n",
    "---\ntags: solo\ntitle: ''\n---\nx\n",
    "---\ntitle: Sourced\nsources:\n  - resource: notes/origin.md\n    title: \"The origin\"\n  - resource: https://example.com/x\n  - resource: ../up.md#part\n  - { resource: flow.md, title: Flow }\n---\n\nBody\n",
    "---\nsources:\n- resource: same.md\n- resource: same.md\n---\n",
    "---\nsources:\n  resource: mapped.md\n  title: Mapped\n---\n",
    "---\nsources: { resource: inline.md }\n---\n",
    "---\nstatus: stable\nstale_after: 2026-01-01T00:00:00Z\ngenerated:\n  by: process:build\nverified:\n  - by: \"human:ana\"\n---\n",
    "---\nstatus: whatever\nverified:\n  - by: tool:x\n---\n",
    "---\nverified:\n  - at: 2026-01-01\n---\n",
    "---\ngenerated:\n  by: tool:x\n---\n",
    "---\n# a comment\ntitle: Refused\nsources:\n  - resource: never.md\n---\n[kept](kept.md)\n",
    "---\r\ntitle: CRLF\r\n---\r\n[crlf](crlf.md)\r\n",
    "+++\ntitle = \"TOML\"\n+++\n[toml](toml.md)\n",
    "---\n  title: stray indent\n---\n",
    "---\nsources:\n  - resource: a.md\n    meta:\n      deep: third level\n---\n",
    "---\ntitle: |\n  block scalar\n---\n",
    "---\nlist:\n  - b:\n---\n",
    "---\n\n---\n[empty block](e.md)\n",
    "---\ntitle: Only frontmatter\n---",
    "---\ntitle: \ud83d\ude00 Emoji\n---\n[\ud83d\ude00 a\u00a0 b](emoji.md) [\ufeffbom\ufeff](bom.md)\n",
    "[&#x1F600; smile](e.md) [n](&#0;.md) [amp](a&amp;b.md) [nope](a&bogus;.md) [nbsp](a&nbsp;b.md)\n",
    "1234567890. not an item [a](a.md)\n\n-     five spaces [five](five.md)\n\n-\t[tab after marker](tab.md)\n",
    "\t[tab code](tab-code.md)\n\n  \t[mixed indent](mixed.md)\n",
    "<span>\n[after a tag line](tagline.md)\n\n[after blank](after-blank.md)\n",
    "Para\n<span>\n[tag cannot interrupt](interrupt.md)\n",
    "> <pre>\n> [in pre](pre.md)\n> </PRE>\n\n[after pre](after-pre.md)\n",
    "<textarea>[inline raw](raw.md)</textarea>\n\n[out](out.md)\n",
    "[a\\]b]: esc.md\n[lbl]: <spaced target.md>\n[bad]: <a<b>\n\n[x][a\\]b] [y][lbl] [z][bad]\n",
    "[[a\\|b|alias]] [[#heading only]] [[ ]] [[x#h|]] [[Target#Head]] [[p/q.md]]\n",
    "[t](t.md 'single') [u](u.md (paren)) [v](<v.md> \"t\") [w](w.md\n\"next\")\n",
    "[deep [nested] label](nested.md) [code `]` label](code-label.md)\n",
    "```\nunclosed fence [hidden](hidden.md)\n",
    "~~~ info with `ticks` ok\n[in tilde](tilde.md)\n~~~\n\n``` bad`info\n[not a fence](not-fence.md)\n",
    "$$ inline $$ [after inline math](after-math.md)\n\n$$\n[in math](in-math.md)\n",
    "###### h6 [six](six.md)\n####### seven [seven](seven.md)\n#nospace [ns](ns.md)\n",
    "- a\n\n   [lazy under item](lazy-item.md)\n\n[back](back.md)\n",
    "-     five spaces opens no item\n\n       [so this is code](after-five.md)\n",
    "[percent](a%20b.md) [hash](a.md#frag) [query](a.md?x=1) [mailto](mailto:x@y.z) [c](C:\\path.md) [frag](#only)\n",
];

// ── the resolver's cases ────────────────────────────────────────────────────

const ROOT = "/ws";
const NOTION = "0123456789abcdef0123456789abcdef";

const FILES: readonly string[] = [
    "index.md", "README.md", "twin.md", "twin.mdx", "only.mdx", "café.md", "UPPER.MD", "..dots.md",
    "notes/alpha.md", "notes/Beta Note.md", "notes/gamma.markdown", "notes/delta.mdx", "notes/data.json",
    "notes/sub/alpha.md", "notes/sub/deep/leaf.md", "other/alpha.md", "other/Alpha.txt",
    "docs/guide/index.md", "docs/hugo/_index.md", "content/write/uber/index.md",
    "images/pic.png", "images/Diagram.PNG",
    `notion/Page ${NOTION}.md`, `notion/Folder ${NOTION}/Child.md`, "renamed/Plain.md", "renamed/Kept.md",
    "space name/file with space.md",
    // Pairs where two steps of the chain would land on different files, so
    // the ORDER of the steps is in the answer: a directory's index against a
    // file of the directory's name, the ancestor walk against the suffix
    // match's shorter decoy, the literal name against its cleaned twin, the
    // Markdown tier against a shorter MDX file.
    "both", "both/index.md", "hugo2.md", "hugo2/_index.md", "content/x/y.md", "z/x/y.md",
    `renamed/Both ${NOTION}.md`, "renamed/Both.md", "pct%20lit.md", "pct lit.md", "pref.mdx", "a/pref.md",
].map((f) => `${ROOT}/${f}`);

const DOCS: readonly string[] = ["index.md", "notes/alpha.md", "notes/sub/deep/leaf.md", "content/write/uber/index.md"]
    .map((f) => `${ROOT}/${f}`);

const LINK_TARGETS: readonly string[] = [
    "alpha.md", "./alpha", "alpha", "../README.md", "/README.md", "README", "/write/uber", "/write/uber/",
    "sub/deep/leaf", "deep/leaf.md", "leaf", "Beta%20Note.md", "Beta Note", "gamma", "delta", "twin", "only",
    "café", "upper", "UPPER.MD", "missing.md", "../images/pic.png", "images/pic.png", "@/notes/alpha", "@/notes/sub/",
    "docs/guide/", "docs/guide", "/docs/hugo/", "hugo", `../notion/Page ${NOTION}.md`, `../renamed/Plain ${NOTION}.md`,
    `renamed/Kept ${NOTION}`, `../notion/Folder ${NOTION}/Child.md`, "%zz.md", "a/../README.md", "////README.md",
    "../../../../../README.md", "space%20name/file%20with%20space", "notes/data.json", "data", "/", "./", "..dots",
    "/both/", "/both", "/hugo2/", "/hugo2", "/x/y", `/renamed/Both ${NOTION}.md`, "/pct%20lit.md", "/pref",
];

const WIKI_TARGETS: readonly string[] = [
    "alpha", "Alpha", "ALPHA", "beta note", "gamma", "delta", "twin", "only", "pic.png", "pic", "Diagram", "notes/alpha",
    "sub/alpha", "missing", `Plain ${NOTION}`, `Kept ${NOTION}`, "  alpha  ", "", "leaf", "upper", "data.json", "café",
    "..dots", "index", "pref", "both", "hugo2", `Both ${NOTION}`, "y",
];

async function resolverCases(): Promise<Array<{ doc: string; target: string; wiki: boolean; expected: string | null }>> {
    const fileSet = new Set(FILES);
    const io: ResolverIo = { isFile: async (abs) => fileSet.has(abs), getFileIndex: async () => FILES };
    const out: Array<{ doc: string; target: string; wiki: boolean; expected: string | null }> = [];
    for (const doc of DOCS) {
        const ctx = { docFsPath: doc, workspaceRootFsPath: ROOT, smartLinks: true };
        for (const target of LINK_TARGETS) {
            out.push({ doc, target, wiki: false, expected: await resolveLinkPath(target, ctx, io) });
        }
        for (const target of WIKI_TARGETS) {
            out.push({ doc, target, wiki: true, expected: await resolveWikiTarget(target, ctx, io) });
        }
    }
    return out;
}

async function generate(): Promise<unknown> {
    const inputs = [
        ...documentsUnder("webview/__tests__/fixtures").map((d) => ({ name: d.name, content: d.content })),
        ...documentsUnder("samples").map((d) => ({ name: d.name, content: d.content })),
        ...corpusContexts().map((content, i) => ({ name: `${CORPUS_TEST} CONTEXTS[${i}]`, content })),
        ...EXTRA.map((content, i) => ({ name: `EXTRA[${i}]`, content })),
    ];
    return {
        notes: inputs.map((input) => ({ ...input, reading: readNote(input.content) })),
        resolver: { root: ROOT, files: FILES, cases: await resolverCases() },
    };
}

describe("the note-link golden file", () => {
    it("should be what the TypeScript answers today", async () => {
        const fresh = await generate();
        if (process.env.BIRTA_WRITE_GOLDEN === "1") {
            fs.writeFileSync(GOLDEN_PATH, JSON.stringify(fresh, null, 1) + "\n");
        }
        const onDisk: unknown = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
        expect(onDisk, "the golden is stale: rewrite it (see this file's header) and run the Swift suite").toEqual(fresh);
    });

    it("should reach every kind of reference, the refusals, and enough resolutions to mean something", async () => {
        const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8")) as {
            notes: Array<{ name: string; reading: ReturnType<typeof readNote> }>;
            resolver: { cases: Array<{ wiki: boolean; expected: string | null }> };
        };
        const links = golden.notes.flatMap((n) => n.reading.links);
        const byKind = (kind: string): number => links.filter((l) => l.kind === kind).length;
        // A golden that recorded nothing would be matched by a port that reads
        // nothing, so its own reach is asserted: every corpus fixture and
        // context, all three kinds in number, frontmatter both read and refused.
        expect(golden.notes.length).toBeGreaterThanOrEqual(40 + corpusContexts().length + EXTRA.length);
        expect(byKind("link")).toBeGreaterThanOrEqual(80);
        expect(byKind("wiki")).toBeGreaterThanOrEqual(40);
        expect(byKind("source")).toBeGreaterThanOrEqual(8);
        expect(golden.notes.filter((n) => n.reading.meta.title !== null).length).toBeGreaterThanOrEqual(10);
        expect(golden.notes.filter((n) => n.reading.meta.trust !== null).length).toBeGreaterThanOrEqual(4);
        const cases = golden.resolver.cases;
        expect(cases.length).toBe(DOCS.length * (LINK_TARGETS.length + WIKI_TARGETS.length));
        expect(cases.filter((c) => c.expected !== null && !c.wiki).length).toBeGreaterThanOrEqual(80);
        expect(cases.filter((c) => c.expected !== null && c.wiki).length).toBeGreaterThanOrEqual(40);
        expect(cases.filter((c) => c.expected === null).length).toBeGreaterThanOrEqual(20);
    });
});
