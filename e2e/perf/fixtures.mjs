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

/** One self-contained rich section, varied by index so headings are unique. */
function richSection(i) {
    const lang = LANGS[i % LANGS.length];
    return `## Section ${i}: mixed content

This is paragraph text for section ${i} with **bold**, *italic*, \`inline code\`,
and a [link](https://example.com/${i}). It is long enough to exercise the
inline parser across a realistic line width and a few wrapped lines of prose.

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

Another paragraph. That is all.
`;

const medium = repeatToSize("# Medium document", 18);   // ~12 KB
const large = repeatToSize("# Large document", 140);     // ~96 KB

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

export const FIXTURES = { tiny, medium, large, "code-heavy": codeHeavy, math };

// ~300 KB — the MAR-137 typing-lag tail (bites from ~40 KB up). Typing-harness
// only: kept out of FIXTURES so `pnpm perf` runtimes and baseline.json stay
// comparable across history. The footnote appendix makes the numbering
// plugin's per-transaction work exercise the with-footnotes path, not just the
// empty-map one.
const xlarge = (() => {
    let out = repeatToSize("# Extra-large document", 440);
    out += "\nClosing notes[^first] with a couple of footnotes[^second].\n\n";
    out += "[^first]: The first closing footnote.\n\n[^second]: The second closing footnote.\n";
    return out;
})();

// tiny isolates the fixed per-keystroke floor; medium/large/xlarge give the
// document-size scaling curve.
export const TYPING_FIXTURES = { tiny, medium, large, xlarge };
