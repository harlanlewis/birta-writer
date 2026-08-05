/**
 * Deterministic markdown fixtures for the launch-perf harness.
 *
 * Content is generated with no Date/random so every run and every machine
 * measures the exact same documents. Sizes are approximate targets; the point
 * is a spread of realistic shapes:
 *   tiny       — trivial doc, isolates fixed boot cost
 *   medium     — mixed prose/lists/tables/links/task-lists/code (typical note)
 *   large      — medium content scaled up, stresses parse + round-trip
 *   code-heavy — many code blocks across languages + a mermaid diagram
 *   math       — inline + block KaTeX, exercises the (lazy) math path
 *   link-heavy — many BARE autolinks on their own lines (provider and not),
 *                exercising the embed recognizer walk that titled links never
 *                reach (bareLinkHref requires text === href) — the path the
 *                2026-07-24 perf review found unmeasured
 *
 * The three PROSE fixtures (tiny/medium/large, and xlarge below, which is built
 * from the same sections) deliberately trip the style check — see
 * STYLE_SENTENCES. The non-prose fixtures do not: code-heavy, math and
 * link-heavy exist to isolate the highlighter, the math path and the embed
 * recognizer, and prose seeded into them would blur what they isolate.
 */

const LANGS = [
    "javascript", "typescript", "python", "rust", "go", "java", "cpp",
    "ruby", "bash", "json", "yaml", "sql", "html", "css", "swift",
];

const CODE_SAMPLES = {
    javascript: "const sum = (a, b) => a + b;\nconsole.log(sum(2, 3));",
    typescript: "function id<T>(x: T): T {\n  return x;\n}",
    python: "def fib(n):\n    return n if n < 2 else fib(n-1) + fib(n-2)",
    rust: "fn main() {\n    println!(\"hello\");\n}",
    go: "package main\nfunc main() { println(\"hi\") }",
    java: "class A { static void m() { System.out.println(1); } }",
    cpp: "#include <cstdio>\nint main() { std::puts(\"x\"); }",
    ruby: "def greet(name)\n  \"hi #{name}\"\nend",
    bash: "for f in *.md; do echo \"$f\"; done",
    json: "{ \"a\": 1, \"b\": [2, 3], \"c\": { \"d\": true } }",
    yaml: "name: demo\nitems:\n  - one\n  - two",
    sql: "SELECT id, name FROM users WHERE active = 1 ORDER BY name;",
    html: "<section><h1>Title</h1><p>Body</p></section>",
    css: ".card { display: flex; gap: 8px; color: var(--fg); }",
    swift: "func square(_ x: Int) -> Int { x * x }",
};

/**
 * Sentences that TRIP the style check, one per line of the rotation below.
 *
 * The prose fixtures used to trip **zero** style checks — `medium` produced 0
 * `.pf-style-hit` elements — so proofreading's scan ran on every measured
 * launch and found nothing, exercising the matcher's traversal but never the
 * decoration-building path that scales with how much a document actually
 * trips. A green gate over that fixture set is evidence of non-interference,
 * not of coverage (MAR-310).
 *
 * Between them these four cover seven categories — fillers, redundancies,
 * clichés, wordiness, AI vocabulary, AI artifacts, passive voice and negative
 * parallelism — so the decorations built are a realistic mix rather than one
 * regex firing repeatedly. Every phrase is verified against the shipped word
 * lists by `fixtures.test.mjs`, which fails if a list edit stops one matching.
 */
const STYLE_SENTENCES = [
    "Basically, we collaborated together on this and, at the end of the day, the results were reviewed by the team.",
    "In my opinion this delves into a rich tapestry of tradeoffs that the reader will actually need to consider.",
    "It is important to note that the plan was approved by the committee due to the fact that nobody objected.",
    "This is not just a refactor, it is a rethink of how the whole thing fits together.",
];

/** Two of the four, rotated by index — ~6 style hits per section. */
function stylePara(i) {
    return `${STYLE_SENTENCES[i % STYLE_SENTENCES.length]} ${STYLE_SENTENCES[(i + 1) % STYLE_SENTENCES.length]}`;
}

/** One self-contained rich section, varied by index so headings are unique. */
function richSection(i) {
    const lang = LANGS[i % LANGS.length];
    return `## Section ${i}: mixed content

This is paragraph text for section ${i} with **bold**, *italic*, \`inline code\`,
and a [link](https://example.com/${i}). It is long enough to exercise the
inline parser across a realistic line width and a few wrapped lines of prose.

${stylePara(i)}

- First bullet in section ${i}
- Second bullet with a [nested link](https://example.com/n/${i})
- Third bullet

1. Ordered one
2. Ordered two

- [ ] Task not done ${i}
- [x] Task done ${i}

> A blockquote for section ${i} that spans
> two source lines to test soft breaks.

| Name | Value | Note |
| --- | --- | --- |
| alpha | ${i} | first |
| beta | ${i * 2} | second |
| gamma | ${i * 3} | third |

\`\`\`${lang}
${CODE_SAMPLES[lang]}
\`\`\`
`;
}

function repeatToSize(header, sectionCount) {
    let out = header + "\n\n";
    for (let i = 1; i <= sectionCount; i++) out += richSection(i) + "\n";
    return out;
}

const tiny = `# Tiny document

A short paragraph with a **bit** of emphasis and a [link](https://example.com).

## Second heading

${STYLE_SENTENCES[0]}
`;

// Section counts are chosen to hold the documented BYTE sizes across the
// style-check seeding, which added ~215 characters to each section: 18→14 and
// 140→108 keeps medium at ~12 KB and large at ~96 KB (within 1% of their
// pre-seeding lengths), so a fixture's identity stays its size. Left alone,
// every prose fixture would have grown ~30% and the typing job — already the
// most expensive check in the repo, and dominated by its largest fixture —
// would have grown with it, for no measurement anyone asked for.
const medium = repeatToSize("# Medium document", 14);   // ~12 KB
const large = repeatToSize("# Large document", 108);     // ~96 KB

const codeHeavy = (() => {
    let out = "# Code-heavy document\n\nExercises highlighter registration across many languages.\n\n";
    for (let i = 0; i < LANGS.length; i++) {
        const lang = LANGS[i];
        out += `## ${lang}\n\n\`\`\`${lang}\n${CODE_SAMPLES[lang]}\n\`\`\`\n\n`;
    }
    // A mermaid block to exercise the (currently eager) mermaid path.
    out += "## diagram\n\n```mermaid\nflowchart LR\n  A[Start] --> B{Choice}\n  B -->|yes| C[Do]\n  B -->|no| D[Skip]\n```\n";
    return out;
})();

const math = (() => {
    let out = "# Math document\n\nInline and block KaTeX to exercise the math path.\n\n";
    for (let i = 1; i <= 12; i++) {
        out += `Inline math number ${i}: $a_${i}^2 + b_${i}^2 = c_${i}^2$ within a sentence.\n\n`;
        out += `$$\n\\int_0^{${i}} x^2 \\, dx = \\frac{${i}^3}{3}\n$$\n\n`;
    }
    return out;
})();

const linkHeavy = (() => {
    // A reading-list/link-dump shape: hundreds of bare autolinks each on its
    // own line, mixing recognized providers (GitHub is the no-network card
    // that renders even offline), non-provider hosts (the recognizer's
    // all-four-extractors miss path), and interleaved prose. Deterministic —
    // ids are index-derived.
    let out = "# Link-heavy document\n\nA reading list of bare links, one per line.\n\n";
    for (let i = 1; i <= 120; i++) {
        out += `Note ${i}: a line of prose between the links.\n\n`;
        out += `https://github.com/owner-${i}/repo-${i}\n\n`;
        out += `https://example.com/article/${i}\n\n`;
        out += `https://www.youtube.com/watch?v=abcdefgh${String(i).padStart(3, "0")}\n\n`;
    }
    return out;
})();

export const FIXTURES = { tiny, medium, large, "code-heavy": codeHeavy, math, "link-heavy": linkHeavy };

// ~300 KB — the MAR-137 typing-lag tail (bites from ~40 KB up). Typing-harness
// only: kept out of FIXTURES so `pnpm perf` runtimes and baseline.json stay
// comparable across history. The footnote appendix makes the numbering
// plugin's per-transaction work exercise the with-footnotes path, not just the
// empty-map one.
const xlarge = (() => {
    let out = repeatToSize("# Extra-large document", 343);
    out += "\nClosing notes[^first] with a couple of footnotes[^second].\n\n";
    out += "[^first]: The first closing footnote.\n\n[^second]: The second closing footnote.\n";
    return out;
})();

// tiny isolates the fixed per-keystroke floor; medium/large/xlarge give the
// document-size scaling curve; link-heavy isolates the embed recognizer's
// per-keystroke cost (the plugin re-walks bare links on every doc change).
export const TYPING_FIXTURES = { tiny, medium, large, xlarge, "link-heavy": linkHeavy };
