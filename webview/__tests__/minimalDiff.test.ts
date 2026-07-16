/**
 * Tests for the minimal-diff merge (applyMinimalChanges) — pure functions on
 * real strings, no mocks.
 *
 * The regression at stake: hitting Enter creates a new paragraph, the
 * serializer emits it with a blank-line separator, and the merge used to drop
 * that blank line — leaving a single newline that Markdown treats as a soft
 * break (formatters then collapse the "paragraphs" into one line).
 */
import { describe, it, expect } from "vitest";
import { applyMinimalChanges } from "../utils/minimalDiff";

describe("applyMinimalChanges — paragraph separators (the Enter bug)", () => {
    it("appending a new paragraph should insert its blank separator", () => {
        const saved = "para1\n";
        const serialized = "para1\n\npara2\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1\n\npara2\n");
    });

    it("inserting a paragraph between two paragraphs should keep all three blank-separated", () => {
        const saved = "para1\n\npara3\n";
        const serialized = "para1\n\npara2\n\npara3\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1\n\npara2\n\npara3\n");
    });

    it("splitting a paragraph in two should yield two blank-separated paragraphs", () => {
        // Enter pressed in the middle of "first second"
        const saved = "intro\n\nfirst second\n";
        const serialized = "intro\n\nfirst\n\nsecond\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("intro\n\nfirst\n\nsecond\n");
    });

    it("inserting a paragraph at the head of the file should keep it separated from the old first paragraph", () => {
        const saved = "para2\n";
        const serialized = "para1\n\npara2\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1\n\npara2\n");
    });
});

describe("applyMinimalChanges — deletions take their separator with them", () => {
    it("deleting a middle paragraph should remove its blank separator too", () => {
        const saved = "para1\n\npara2\n\npara3\n";
        const serialized = "para1\n\npara3\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1\n\npara3\n");
    });

    it("deleting the first paragraph should not leave a leading blank line", () => {
        const saved = "para1\n\npara2\n";
        const serialized = "para2\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para2\n");
    });

    it("deleting the last paragraph should not leave trailing blank lines", () => {
        const saved = "para1\n\npara2\n";
        const serialized = "para1\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1\n");
    });

    it("merging two paragraphs (backspace at paragraph start) should collapse their separator", () => {
        const saved = "para1\n\npara2\n";
        const serialized = "para1para2\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1para2\n");
    });

    it("deleting all content should return the serialized output", () => {
        const saved = "para1\n\npara2\n";
        const serialized = "";

        expect(applyMinimalChanges(saved, serialized)).toBe("");
    });

    it("repeated insert/delete cycles should not accumulate blank lines", () => {
        // Arrange: a stable two-paragraph file
        const original = "para1\n\npara3\n";
        const withInsert = "para1\n\npara2\n\npara3\n";

        // Act: insert para2 then delete it again, three times over
        let file = original;
        for (let cycle = 0; cycle < 3; cycle++) {
            file = applyMinimalChanges(file, withInsert);
            file = applyMinimalChanges(file, original);
        }

        // Assert: byte-identical to where we started
        expect(file).toBe(original);
    });
});

describe("applyMinimalChanges — untouched formatting is preserved", () => {
    it("identical content should return the saved string itself (identity)", () => {
        const saved = "para1\n\npara2\n";

        expect(applyMinimalChanges(saved, saved)).toBe(saved);
    });

    it("an in-place text edit should preserve the user's double blank lines around it", () => {
        const saved = "para1\n\n\npara2 old\n";
        const serialized = "para1\n\npara2 new\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1\n\n\npara2 new\n");
    });

    it("serializer emitting single blanks where the file has doubles should change nothing", () => {
        const saved = "para1\n\n\npara2\n";
        const serialized = "para1\n\npara2\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(saved);
    });

    it("a leading blank line should survive an unrelated edit below", () => {
        const saved = "\npara1\n\npara2 old\n";
        const serialized = "para1\n\npara2 new\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("\npara1\n\npara2 new\n");
    });

    it("table separator rows differing only in dash width should compare as unchanged", () => {
        const saved = "| a | b |\n| :--- | ---: |\n| 1 | 2 |\n";
        const serialized = "| a | b |\n|:-|-:|\n| 1 | 2 |\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(saved);
    });

    it("thematic breaks differing in marker CHAR should compare as an edit (never cross-repaired)", () => {
        // REVERSED from the original pin (MAR-161 M2): keying `***` equal to
        // a `-` run let the merge "repair" a moved setext heading's
        // underline into a saved hr's bytes, dissolving the heading — a
        // dash run's meaning depends on the line above it, so cross-
        // character equivalence can silently swap constructs. The serializer
        // preserves the saved marker style (sourceStyle, since 0.2.3), so
        // same-document saves emit matching chars and nothing legitimate
        // relies on this equivalence anymore. A cross-char difference is now
        // an honest edit: the serialized bytes land.
        const saved = "para1\n\n***\n\npara2\n";
        const serialized = "para1\n\n---\n\npara2\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(serialized);
    });

    it("thematic breaks differing only in repetition or spacing should compare as unchanged", () => {
        const saved = "para1\n\n- - -\n\npara2\n";
        const serialized = "para1\n\n-----\n\npara2\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(saved);
    });

    it("editing text next to a same-char rule should not rewrite the rule's style run", () => {
        // The style-preservation contract, restated for the char-preserving
        // normalizer: within one marker character, spacing/repetition styles
        // still compare equal and the saved bytes win.
        const saved = "intro\n\n- - -\n\noutro old\n";
        const serialized = "intro\n\n---\n\noutro new\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("intro\n\n- - -\n\noutro new\n");
    });

    it("table cells differing only in padding or <br /> placeholders should compare as unchanged", () => {
        const saved = "| fruit | price |\n| --- | --- |\n| apple |  |\n";
        const serialized = "| fruit | price |\n| --- | --- |\n| apple | <br /> |\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(saved);
    });

    it("editing one table cell should not reformat the other rows", () => {
        const saved = "| fruit | price |\n| ----- | ----- |\n| apple | 1     |\n| pear  | 2     |\n";
        const serialized = "| fruit | price |\n| --- | --- |\n| apple | 1 |\n| pear | 9 |\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(
            "| fruit | price |\n| ----- | ----- |\n| apple | 1     |\n| pear | 9 |\n",
        );
    });

    it("adjacent strong runs split by the serializer should compare as unchanged", () => {
        const saved = "**bold [link](https://a.b) text**\n";
        const serialized = "**bold [link](https://a.b)** **text**\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(saved);
    });

    it("legacy whole-link emphasis vs the new emphasis-inside form should compare as unchanged", () => {
        // Older builds (and hand-written files) wrap the emphasis around the
        // whole link; the fidelity serializer emits emphasis inside the link
        // text. On kept lines the saved bytes must win.
        const cases: Array<[saved: string, serialized: string]> = [
            ["**[x](https://a.b)**\n", "[**x**](https://a.b)\n"],
            ["*[x](https://a.b)*\n", "[*x*](https://a.b)\n"],
            ["~~[x](https://a.b)~~\n", "[~~x~~](https://a.b)\n"],
            ["***[x](https://a.b)***\n", "[***x***](https://a.b)\n"],
        ];
        for (const [saved, serialized] of cases) {
            expect(applyMinimalChanges(saved, serialized)).toBe(saved);
        }
    });

    it("legacy split-strong around a link vs the new merged form should compare as unchanged", () => {
        // normalizeSplitStrong must run FIRST: the legacy split form merges
        // into `**a [l](u) b**`, which the wrapped-emphasis rewrite then
        // leaves alone (the markers are not flush against the link).
        const saved = "**a** **[l](https://a.b)** **b**\n";
        const serialized = "**a [l](https://a.b) b**\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(saved);
    });

    it("an edit elsewhere should not rewrite an untouched legacy wrapped-emphasis link", () => {
        const saved = "**[x](https://a.b)**\n\npara old\n";
        const serialized = "[**x**](https://a.b)\n\npara new\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(
            "**[x](https://a.b)**\n\npara new\n",
        );
    });

    it("a fence language with leading space should compare as unchanged", () => {
        const saved = "``` javascript\nconst x = 1;\n```\n";
        const serialized = "```javascript\nconst x = 1;\n```\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(saved);
    });

    it("blank lines inside a fenced code block should survive an edit elsewhere", () => {
        const saved = "```\nline1\n\nline2\n```\n\ntext old\n";
        const serialized = "```\nline1\n\nline2\n```\n\ntext new\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(
            "```\nline1\n\nline2\n```\n\ntext new\n",
        );
    });
});

describe("applyMinimalChanges — list and boundary behavior", () => {
    it("inserting an item into a tight list should not add blank lines", () => {
        const saved = "- a\n- c\n";
        const serialized = "- a\n- b\n- c\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("- a\n- b\n- c\n");
    });

    it("typing the first paragraph into an empty file should produce just that paragraph", () => {
        const saved = "";
        const serialized = "para1\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1\n");
    });

    it("appending to a file without a trailing newline should end with the serializer's trailing newline", () => {
        const saved = "para1";
        const serialized = "para1\n\npara2\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1\n\npara2\n");
    });

    it("an in-place edit in a file without a trailing newline should keep lacking it", () => {
        const saved = "para1 old";
        const serialized = "para1 new\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("para1 new");
    });
});

describe("applyMinimalChanges — quote-merge blank line (MAR-122)", () => {
    it("a block moved between callouts should not keep the stale separator blank", () => {
        // A block moves out of the WARNING callout into the IMPORTANT one; the
        // serializer merges them (`>` continuation, no blank). The saved blank
        // that separated the two callouts must NOT survive, or the merged quote
        // reopens split into a separate bare blockquote.
        const saved = "> [!IMPORTANT]\n> Purple.\n\n> [!WARNING]\n> Yellow.\n";
        const serialized = "> [!IMPORTANT]\n> Purple.\n>\n> Yellow.\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(serialized);
    });

    it("a plain blockquote absorbing a following quote should not keep the blank", () => {
        const saved = "> a\n\n> b\n";
        const serialized = "> a\n>\n> b\n"; // merged into one blockquote

        expect(applyMinimalChanges(saved, serialized)).toBe(serialized);
    });

    it("two genuinely separate quotes keep their separator (no churn)", () => {
        // The serializer keeps them separate (blank between), so the saved
        // blank is a real separator and must be preserved.
        const saved = "> a\n\n> b\n";
        const serialized = "> a\n\n> c\n"; // edited b→c, still two quotes

        expect(applyMinimalChanges(saved, serialized)).toBe("> a\n\n> c\n");
    });

    it("a user's double blank between separate quotes is preserved", () => {
        // Both sides keep the quotes separate; the extra blank is the user's
        // spacing and the merge must not canonicalize it.
        const saved = "> a\n\n\n> b\n";
        const serialized = "> a\n\n> b\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("> a\n\n\n> b\n");
    });

    it("a blank between a quote and a non-quote line is untouched", () => {
        const saved = "> a\n\nplain\n";
        const serialized = "> a\n\nplain\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(saved);
    });
});

describe("applyMinimalChanges — attachment-sensitive blank lines (MAR-161 M1)", () => {
    it("raw ':::' prose replacing a directive close keeps the serializer's separating blank", () => {
        // The distilled M1 shape: fence prose moves to a directive body's
        // tail; the serializer lengthens the outer fence and emits a blank
        // to keep the raw `:::` line inert. The LCS pairs the old close
        // fence with the moved prose as an in-place replacement, whose
        // saved spacing was GLUED — gluing would re-attach the prose to the
        // paragraph above (a `:::` line cannot interrupt a paragraph).
        const saved =
            ":::tip Title\nBody para.\n:::\n\nOther one.\n\nOther two.\n\n::: raw prose line\n";
        const serialized =
            "::::tip Title\nBody para.\n\n::: raw prose line\n::::\n\nOther one.\n\nOther two.\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(serialized);
    });

    it("an hr replacing a glued paragraph line keeps its separating blank (never a setext)", () => {
        // Same rule, dash arm: gluing `---` under "alpha" would turn the
        // paragraph into a setext heading (setext takes precedence over hr).
        const saved = "alpha\nold line\n\ntail\n";
        const serialized = "alpha\n\n---\n\ntail\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(serialized);
    });

    it("an edit elsewhere leaves a directive glued under a heading NOT separated", () => {
        // A heading terminates its own block, so the glued `:::note` parses
        // as a directive either way — the saved spacing is the user's style
        // and must survive an unrelated edit. (An edit elsewhere is required
        // to exercise the rule at all: with zero edits the merge
        // short-circuits to the saved bytes before any gap decision runs.)
        const saved = "# H\n:::note\nbody\n:::\n\ntail old\n";
        const serialized = "# H\n\n:::note\nbody\n:::\n\ntail new\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(
            "# H\n:::note\nbody\n:::\n\ntail new\n",
        );
    });
});

describe("applyMinimalChanges — line classification (MAR-161): keys never cross constructs", () => {
    it("a whitespace-only tab→space edit inside a top-level fence should register as an edit", () => {
        // Top-level fence content is verbatim user bytes (a Makefile recipe
        // line): the outline-indent normalizer must not equate the tab with
        // two spaces here, or the edit is silently dropped on save.
        const saved = "```make\nall:\n\tcc main.c\n```\n";
        const serialized = "```make\nall:\n  cc main.c\n```\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(serialized);
    });

    it("nested-fence content keeps depth-normalized comparison (Logseq outline, no churn)", () => {
        // A fence nested in a tab-indented outline re-serializes with space
        // indentation (MAR-131); every line must still compare equal or an
        // untouched file churns on save.
        const saved = "- bullet\n\t- child\n\t  ```js\n\t  code()\n\t  ```\n";
        const serialized = "- bullet\n  - child\n    ```js\n    code()\n    ```\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(saved);
    });

    it("a tab-indented lazy continuation stays outline-normalized (not indented code)", () => {
        const saved = "- item\n\tcontinuation\n";
        const serialized = "- item\n  continuation\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(saved);
    });

    it("an hr glued under a table keeps its glue across an unrelated edit (no setext misread)", () => {
        // A table row cannot be underlined — `---` after it is an hr whether
        // glued or separated, so the saved glue is the user's style. The
        // setext classifier must not key the saved side differently from
        // the serializer's blank-separated emission (review finding 2).
        const saved = "| a | b |\n| --- | --- |\n| c | d |\n---\n\ntail old\n";
        const serialized = "| a | b |\n| --- | --- |\n| c | d |\n\n---\n\ntail new\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(
            "| a | b |\n| --- | --- |\n| c | d |\n---\n\ntail new\n",
        );
    });

    it("an hr glued under a quote or list item keeps its glue across an unrelated edit", () => {
        // A setext underline cannot be a lazy continuation, so `> quote` /
        // `- item` glued above `---` parse as quote/list + hr — the dash arm
        // of the attachment rule must stay silent there (review finding 3).
        const savedQuote = "> quote\n---\n\ntail old\n";
        const serializedQuote = "> quote\n\n---\n\ntail new\n";
        expect(applyMinimalChanges(savedQuote, serializedQuote)).toBe(
            "> quote\n---\n\ntail new\n",
        );

        const savedList = "- item\n---\n\ntail old\n";
        const serializedList = "- item\n\n---\n\ntail new\n";
        expect(applyMinimalChanges(savedList, serializedList)).toBe(
            "- item\n---\n\ntail new\n",
        );
    });

    it("indented code glued after a fence close classifies as code on both sides", () => {
        // A fence close terminates its block, so the glued indented line IS
        // code — the classifier must not read it as a lazy continuation on
        // the saved side while the serializer's blank-separated emission
        // reads as code (review finding 4: key mismatch on an untouched
        // line let the serializer's spacing win).
        const saved = "```\nx\n```\n    indented code\n\ntail old\n";
        const serialized = "```\nx\n```\n\n    indented code\n\ntail new\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(
            "```\nx\n```\n    indented code\n\ntail new\n",
        );
    });

    it("a setext heading moved above a dash hr keeps its underline (never the hr's bytes)", () => {
        // The M2 dash residual: a spaced `- - -` hr and an attached `----`
        // underline used to share the key `---`, which tied the LCS between
        // "keep the heading" and "keep the hr" — and the wrong pick emitted
        // the saved hr bytes where the underline belongs, dissolving the
        // heading on reopen (a spaced run cannot be a setext underline).
        // Setext-classified underlines key by their raw bytes, so the hr can
        // never stand in for one.
        const saved = "alpha\n\n- - -\n\nT\n----\n\nomega\n";
        const serialized = "alpha\n\nT\n----\n\n- - -\n\nomega\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(serialized);
    });
});
