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
 *                reach (bareLinkHref requires text === href)
 *   html-heavy — raw HTML atoms, block and inline, exercising the html
 *                NodeView's per-atom mount path (MAR-367)
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
 * The prose fixtures MUST trip the style check. Proofreading ships on, so
 * every measured launch runs its scan; over prose that matches nothing the
 * scan exercises the matcher's traversal but never the decoration-building
 * path, which is the half that scales with how much a document actually trips.
 * A green gate over such a fixture set is evidence of non-interference, not of
 * coverage (MAR-310).
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

// A FIXTURE'S IDENTITY IS ITS SIZE, so the section counts are derived from the
// documented byte sizes and not the other way round: 14 and 108 hold medium at
// ~12 KB and large at ~96 KB. Re-derive them whenever a section's content
// changes — the style-check seeding grew each one by ~215 characters, and left
// alone would have grown every prose fixture ~30%, taking the typing job (the
// most expensive check in the repo, dominated by its largest fixture) with it
// for no measurement anyone asked for.
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

const htmlHeavy = (() => {
    // Isolates the html NodeView the way code-heavy isolates the highlighter.
    // Its mount path is PER ATOM: the view resolves a position and walks
    // siblings to decide whether the atom owns its whole block
    // (`isSoleBlockAtom`), sanitizes through the lazy DOMPurify chunk, and
    // sweeps the rendered subtree for focusables. So the cost that matters
    // scales with atom COUNT, and the fixture's job is to hold many.
    //
    // Three shapes, because they take different branches. A block atom alone in
    // its block is the sole-block case; an atom sharing a paragraph with text is
    // not, and inline pairs are the shape `htmlLivePairs` walks. The anchors and
    // the button are there for the focusable sweep, which finds nothing in a
    // fixture of bare `<div>`s and would then be measured doing nothing.
    //
    // NOT seeded into a gated fixture on purpose. Inflating medium/large/
    // realistic shifts a baseline the launch gate compares against and spends CI
    // time on every future PR, which is a call about what the gate should cost
    // rather than a detail to slip in here (MAR-367).
    let out = "# HTML-heavy document\n\nRaw HTML the way a working file carries it: pasted callouts, inline markup, embedded anchors.\n\n";
    for (let i = 1; i <= 40; i++) {
        out += `## HTML section ${i}\n\n`;
        // A sole block atom, with a focusable inside it.
        out += `<div class="callout tone-${i}">\n  <strong>Note ${i}</strong>\n  <a href="https://example.com/${i}">the reference</a>\n</div>\n\n`;
        // Inline pairs sharing a paragraph with real text.
        out += `Paragraph ${i} carries <b>bold</b> and <em>emphasis</em> as raw tags, plus <span class="tag">a span</span> mid-sentence, which is how a converted document arrives.\n\n`;
        // A block atom that does NOT own its block: text, then a tag, then text.
        out += `Trailing prose for ${i} <br /> continues after a break tag.\n\n`;
        // A table cell's worth of markup, the shape an export tool emits.
        out += `<details>\n  <summary>Detail ${i}</summary>\n  <p>Body text for detail ${i}.</p>\n  <button type="button">Act ${i}</button>\n</details>\n\n`;
    }
    return out;
})();

// ── realistic ───────────────────────────────────────────────────────────────
// A working-file construct MIX the homogeneous fixtures can't produce: 7-row
// tables, HTML-labeled mermaid (subgraphs, stateDiagram, styled nodes),
// 900-char single-line paragraphs, style-seeded prose. A real document's cost
// cliff is usually an interaction between constructs. All five diagrams are
// valid — the invalid-diagram path is pinned by e2e/corpus and mermaidRender.

const REALISTIC_DIAGRAMS = [
    `\`\`\`mermaid
flowchart TB
    JOBS(["<b>Jobs running<br/>in production</b>"])
    JOBS --> RETRY["<b>Retry</b><br/>an operator re-runs the job"]
    RETRY -->|"hours"| JOBS
    JOBS --> REG["<b>Regression</b><br/>failures become test cases"]
    REG -->|"days"| JOBS
    JOBS --> REP["<b>Reporting</b><br/>the results roll up"]
    REP -->|"weeks"| JOBS
\`\`\``,
    `\`\`\`mermaid
stateDiagram-v2
    [*] --> Staging
    Staging --> Canary: smoke suite green
    Canary --> Gradual: error budget holds
    Gradual --> Full: p99 stable over N hours
    Full --> Gradual: regression detected, auto-rollback
\`\`\``,
    `\`\`\`mermaid
flowchart LR
    A["Ingest"] --> B["Validator"]
    B --> C["Enrichment<br/>& joins"]
    C --> D["Quality gate"]
    D --> E["The load"]
    E --> F["Report"]
    F -.->|"the correction returns"| A
    style A fill:#1f6feb,color:#fff
    style F fill:#8957e5,color:#fff
\`\`\``,
    `\`\`\`mermaid
flowchart TB
    subgraph BASE["<b>PLATFORM</b> - standing, not per-dataset"]
        S["Connectors · Scheduler<br/>Rules · Observability"]
    end
    subgraph ONB["<b>ONBOARDING</b> - per dataset"]
        direction LR
        C1["Request"] --> C2["Profiling"] --> C3["Contract"] --> C4["Sandbox"]
    end
    BASE ==> ONB
    C4 --> HAND["Handed back<br/><i>next day</i>"]
    HAND -->|"<b>correction</b>"| C2
    HAND ==> RUN["<b>RUNNING</b>"]
    RUN -.->|"rule contributions"| BASE
\`\`\``,
    `\`\`\`mermaid
flowchart LR
    REQ["Dataset request"] --> PROF["Profiling<br/>+ rule match"]
    PROF --> MAP["Contracts · mapping"]
    MAP --> SBX["Sandbox<br/>sample runs"]
    SBX --> BACK["Handed back"]
    BACK -->|"<b>'not our layout'</b>"| PROF
    PROF -.->|"no rule matched"| LIB["Rule backlog"]
    LIB -.-> PROF
\`\`\``,
];

/** One ~900-char paragraph on ONE line, varied by index. */
function longLine(i) {
    const clause = `the rollout for cohort ${i} keeps its numbers linked at the point of claim rather than restated, because a figure that is recomputed drifts and a figure that is linked stays honest`;
    let line = `Paragraph ${i} runs long without a break the way pasted meeting notes do: `;
    while (line.length < 900) line += clause + ", and ";
    return line + "which is where it stops.";
}

/** A 7-row × 6-column table, the shape the 3×3 generated tables never reach. */
function wideTable(i) {
    const rows = ["retry", "regression", "reporting", "access", "schema", "tooling", "billing"];
    let out = "| Cycle | Owner | Needs | Clock | Status | Note |\n|---|---|---|---|---|---|\n";
    rows.forEach((r, j) => {
        out += `| **${r}** | Owner ${i}-${j} | \`need-${i}-${j}\` | ${j + 1}d | ${j % 2 ? "live" : "planned"} | [ref](https://example.com/${i}/${j}) |\n`;
    });
    return out;
}

function realisticSection(i) {
    const flavors = [
        `${longLine(i)}\n\n${stylePara(i)}\n`,
        `${wideTable(i)}\n${stylePara(i)}\n`,
        `> A quoted claim for section ${i} that spans\n> two source lines.\n\n- [ ] Open item ${i}\n- [x] Closed item ${i}\n- A bullet with a [link](https://example.com/s/${i}) and \`inline code\`\n\n${stylePara(i)}\n`,
    ];
    return `## Realistic section ${i}\n\n${flavors[i % flavors.length]}`;
}

const realistic = (() => {
    let out = "# Realistic document\n\nA working file's construct mix: wide tables, HTML-labeled diagrams, unwrapped paragraphs.\n\n";
    // 65 sections ≈ 60 KB, the size of the motivating document. Re-derive the
    // count if a section's content changes (see the medium/large note above).
    for (let i = 1; i <= 65; i++) {
        out += realisticSection(i) + "\n";
        // Five diagrams total, interspersed rather than appended, so their
        // NodeViews land between tables and long paragraphs like a real doc.
        if (i % 13 === 0 && i / 13 <= REALISTIC_DIAGRAMS.length) {
            out += REALISTIC_DIAGRAMS[i / 13 - 1] + "\n\n";
        }
    }
    return out;
})();

export const FIXTURES = { tiny, medium, large, "code-heavy": codeHeavy, math, "link-heavy": linkHeavy, "html-heavy": htmlHeavy, realistic };

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
