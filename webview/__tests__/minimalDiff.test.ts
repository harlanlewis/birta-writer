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
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";

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

describe("applyMinimalChanges — an edited line keeps the parts the user didn't touch (MAR-213/MAR-214)", () => {
    it("editing a tab-indented outline block should keep its tab so the subtree survives", () => {
        // MAR-213. The edited line used to be written with the serializer's
        // 2-space indent while its untouched grandchild kept its tabs — and a
        // tab is 4 columns to 2 spaces' 2, so the grandchild landed 4+ columns
        // inside the edited item's content and stopped being a list item at
        // all (absorbed as an escaped literal `\- grand`).
        const saved = "- parent\n\t- child\n\t\t- grand\n";
        const serialized = "- parent\n  - childQ\n    - grand\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(
            "- parent\n\t- childQ\n\t\t- grand\n",
        );
    });

    it("outdenting a nested item should still register as a real edit", () => {
        // The guard on the indent carry: `\t` and `` do NOT key equal, so this
        // is a genuine depth change and the serializer's indent must win.
        const saved = "- parent\n\t- child\n";
        const serialized = "- parent\n- childQ\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("- parent\n- childQ\n");
    });

    it("indenting a top-level item deeper should still register as a real edit", () => {
        const saved = "- parent\n- child\n";
        const serialized = "- parent\n  - childQ\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("- parent\n  - childQ\n");
    });

    it("editing one table cell should keep an untouched sibling cell's `<br />` bytes", () => {
        // MAR-214. `<br />` keys equal to an empty cell (older saves wrote
        // empty cells that way), so a zero-edit save is a plain `keep` and no
        // protection region ever forms — the loss is purely that editing ANY
        // cell re-emitted the whole row, emptying a cell the user never
        // visited.
        const saved = "| a | b |\n| --- | --- |\n| <br /> | note |\n";
        const serialized = "| a | b |\n| --- | --- |\n|  | noteQ |\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(
            "| a | b |\n| --- | --- |\n| <br /> | noteQ |\n",
        );
    });

    it("editing one table cell should keep a sibling cell's `<br/>` spelling", () => {
        const saved = "| a | b |\n| --- | --- |\n| x<br/>y | note   |\n";
        const serialized = "| a | b |\n| --- | --- |\n| x<br />y | noteQ |\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(
            "| a | b |\n| --- | --- |\n| x<br/>y | noteQ |\n",
        );
    });

    it("the edited cell's own new bytes should land (salvage never overrides a real change)", () => {
        const saved = "| a | b |\n| --- | --- |\n| keep | old |\n";
        const serialized = "| a | b |\n| --- | --- |\n| keep | new |\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(
            "| a | b |\n| --- | --- |\n| keep | new |\n",
        );
    });

    it("a column alignment change should land (separator rows are never salvaged)", () => {
        const saved = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
        const serialized = "| a | b |\n| :-: | ---: |\n| 1 | 2 |\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(serialized);
    });
});

describe("applyMinimalChanges — editing a line's neighbour too (MAR-303)", () => {
    // A save carries every edit made since the last one, so two adjacent lines
    // edited in one sitting arrive as ONE change region. The merge used to
    // read that region by adjacency — `del` immediately followed by `ins` —
    // and since the LCS emits a region's dels and then its inses, that found
    // the LAST saved line beside the FIRST serialized one. Every carry below
    // already worked when the line was edited alone; each one is here because
    // touching its neighbour in the same save silently switched it off.
    //
    // The serializer output in each case is what the real editor produces —
    // captured by driving the fixture through it, not composed by hand.

    it("two table rows edited together should each keep their own untouched cell", () => {
        const saved = "| a | b |\n| --- | --- |\n| <br /> | one |\n| <br /> | two |\n";
        const serialized = "| a | b |\n| --- | --- |\n|  | oneX |\n|  | twoX |\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(
            "| a | b |\n| --- | --- |\n| <br /> | oneX |\n| <br /> | twoX |\n",
        );
    });

    it("a cell's bytes should never land in a different row", () => {
        // The mispairing's other half: the first row was handed the SECOND
        // row's saved cell. Here only the lower row carries the legacy bytes,
        // so a wrong pairing is visible as content moving up a row rather than
        // merely being lost.
        const saved = "| a | b |\n| --- | --- |\n|  | one |\n| <br /> | two |\n";
        const serialized = "| a | b |\n| --- | --- |\n|  | oneX |\n|  | twoX |\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(
            "| a | b |\n| --- | --- |\n|  | oneX |\n| <br /> | twoX |\n",
        );
    });

    it("sibling list items edited together should each keep the file's indent unit", () => {
        // A four-space outline: the serializer writes depth 1 as two spaces,
        // and the file's own spelling is carried back onto every edited line.
        // Editing the siblings together used to leave the first at four
        // columns and the rest at two — two conventions inside one list.
        const saved = "- alpha\n    - beta\n    - gamma\n    - delta\n";
        const baseline = "- alpha\n  - beta\n  - gamma\n  - delta\n";
        const serialized = "- alpha\n  - betaX\n  - gammaX\n  - deltaX\n";
        const protection = computeRoundTripProtection(saved, baseline);

        expect(applyMinimalChanges(saved, serialized, protection)).toBe(
            "- alpha\n    - betaX\n    - gammaX\n    - deltaX\n",
        );
    });

    it("a tab outline's items edited together should all stay tab-indented", () => {
        // A plain tab outline round-trips under the profile's own keys, so it
        // carries no protection at all — the carry here is rule 1's, off the
        // lines' own bytes.
        const saved = "- alpha\n\t- beta\n\t- gamma\n";
        const serialized = "- alpha\n  - betaX\n  - gammaX\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(
            "- alpha\n\t- betaX\n\t- gammaX\n",
        );
    });
});

describe("applyMinimalChanges — construct classification on CRLF files (MAR-223)", () => {
    // A consequence of the engine handing the profile ending-stripped lines
    // that is worth pinning on its own: several markdown normalizers are
    // `$`-anchored against the raw line (`THEMATIC_BREAK_RE`, `SETEXT_DASH_RE`,
    // the dash arm of `glueChangesConstruct`). A trailing `\r` defeated every
    // one of them, so on a CRLF file a thematic break was never recognized as
    // a thematic break at all — it keyed as ordinary prose, which means its
    // style was NOT protected and the serializer's spelling won.
    it("a thematic break's style should survive an edit elsewhere in a CRLF file", () => {
        const saved = "alpha\r\n\r\n- - -\r\n\r\nomega\r\n";
        // The serializer canonicalizes the divider to `---` and the user edits
        // an unrelated line. The divider must keep the spelling it was written
        // with, exactly as it does in an LF file.
        const serialized = "alpha\n\n---\n\nomega EDITED\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(
            "alpha\r\n\r\n- - -\r\n\r\nomega EDITED\r\n",
        );
    });

    it("the same document written with LF should behave identically", () => {
        const saved = "alpha\n\n- - -\n\nomega\n";
        const serialized = "alpha\n\n---\n\nomega EDITED\n";

        expect(applyMinimalChanges(saved, serialized)).toBe("alpha\n\n- - -\n\nomega EDITED\n");
    });
});

describe("applyMinimalChanges — outlines that mix indent units (MAR-222)", () => {
    // `\t` normalizes to two spaces, which is exactly the serializer's indent
    // for one list level, so a plain tab keys EQUAL and its line is an
    // edit-proof `keep`. `\t   ` normalizes to five columns against the
    // serializer's four, so it keys unequal and is held only by a round-trip
    // protection region — and editing the construct is precisely what releases
    // protection. The edited line alone then came back with the serializer's
    // indent, under a parent still holding a tab, and stopped being its child.
    //
    // Every BASELINE string below was captured from the production serializer
    // rather than imagined. That capture is the only thing making them real:
    // `computeRoundTripProtection` returns non-null for a WRONG baseline too,
    // so a non-null assertion is not evidence of anything here. The tests that
    // would keep passing with `protection = null` (the two guards) are marked
    // as such. mixedIndentOutline.test.ts is the end-to-end pin and derives its
    // baseline from the live editor, so it cannot drift at all.
    const SAVED = "- a\n\t- b\n\t   - c\n";
    const BASELINE = "- a\n  - b\n    - c\n";

    it("editing the deepest line of a mixed-unit outline should keep its own indent", () => {
        const protection = computeRoundTripProtection(SAVED, BASELINE);
        expect(protection).not.toBeNull();

        expect(applyMinimalChanges(SAVED, "- a\n  - b\n    - cQ\n", protection)).toBe(
            "- a\n\t- b\n\t   - cQ\n",
        );
    });

    it("a SECOND edit to that line should keep the indent too", () => {
        // Protection is computed once at load while the saved text moves on
        // after every save, so anything the merge learns from the baseline has
        // to survive the saved bytes drifting out from under it. Keying what
        // the file taught by INDENT rather than by line content is what makes
        // that true — the line's text has changed here, its indent has not.
        const protection = computeRoundTripProtection(SAVED, BASELINE);
        const once = applyMinimalChanges(SAVED, "- a\n  - b\n    - cQ\n", protection);

        expect(applyMinimalChanges(once, "- a\n  - b\n    - cQQ\n", protection)).toBe(
            "- a\n\t- b\n\t   - cQQ\n",
        );
    });

    it("outdenting that line should still register as a real edit", () => {
        // A guard, not a fix pin: this also passes with no protection at all,
        // because key equality declines here too.
        const protection = computeRoundTripProtection(SAVED, BASELINE);

        expect(applyMinimalChanges(SAVED, "- a\n  - b\n  - cQ\n", protection)).toBe(
            "- a\n\t- b\n  - cQ\n",
        );
    });

    it("indenting that line deeper should still register as a real edit", () => {
        // Also a guard that passes without protection — see the test above.
        const protection = computeRoundTripProtection(SAVED, BASELINE);

        expect(applyMinimalChanges(SAVED, "- a\n  - b\n      - cQ\n", protection)).toBe(
            "- a\n\t- b\n      - cQ\n",
        );
    });

    it("an ambiguous indent should fall back to key equality while an unambiguous one is carried", () => {
        // A tab means one list level in the outline and a literal tab inside a
        // top-level fence, so `\t` has no single canonical rendering in this
        // file and is dropped rather than guessed. The outline must still
        // survive on the older key-equality rule (MAR-213), and `\t   `, which
        // IS unambiguous, must still be carried.
        const saved = "- alpha\n\t- beta\n\t   - gamma\n\n```sh\n\techo hi\n```\n";
        const baseline = "- alpha\n  - beta\n    - gamma\n\n```sh\n\techo hi\n```\n";
        const protection = computeRoundTripProtection(saved, baseline);
        expect(protection).not.toBeNull();

        expect(
            applyMinimalChanges(saved, "- alpha\n  - betaQ\n    - gamma\n\n```sh\n\techo hi\n```\n", protection),
        ).toBe("- alpha\n\t- betaQ\n\t   - gamma\n\n```sh\n\techo hi\n```\n");
        expect(
            applyMinimalChanges(saved, "- alpha\n  - beta\n    - gammaQ\n\n```sh\n\techo hi\n```\n", protection),
        ).toBe("- alpha\n\t- beta\n\t   - gammaQ\n\n```sh\n\techo hi\n```\n");
    });

    it("an indent the file renders two ways should be dropped, not guessed", () => {
        // `\t   ` is a level-2 bullet child in the first outline (the
        // serializer renders it as four spaces) and a level-1 child of a
        // five-column `100.` marker in the second (five spaces). One source
        // indent, two canonical renderings, so the file has NOT taught a rule
        // and the fact is dropped — the edit falls back to key equality, which
        // declines, and the serializer's indent wins.
        //
        // This is the test that discriminates the ambiguity drop: keeping the
        // FIRST rendering instead of dropping would carry `\t   ` here, and
        // every other test in this file passes either way.
        const saved = "- a\n\t- b\n\t   - c\n\n100. one\n\t   - child\n";
        const baseline = "- a\n  - b\n    - c\n\n100. one\n     - child\n";
        const protection = computeRoundTripProtection(saved, baseline);

        expect(
            applyMinimalChanges(saved, "- a\n  - b\n    - cQ\n\n100. one\n     - child\n", protection),
        ).toBe("- a\n\t- b\n    - cQ\n\n100. one\n\t   - child\n");
    });

    // ── The facts are distilled once, at load; the saved text is not ────────
    //
    // Both of these are documents the baseline never saw, and both were REAL
    // regressions introduced by the first cut of MAR-222 (found by review,
    // reproduced, fixed). They are the reason rule 2 may only grant a carry and
    // only on list-marker lines — see carrySavedIndent.

    it("a fact learned from an unrelated construct should not disable the tab carry", () => {
        // Loaded as an ORDERED list, whose wider marker teaches `\t` -> three
        // spaces. The user then appends a BULLET outline, where a tab means two
        // spaces instead. Editing inside that outline must still keep its tab:
        // writing the serializer's two spaces while the untouched grandchild
        // keeps `\t\t` lands the grandchild 4+ columns in, where it stops being
        // a list item and reparses as indented code — the MAR-222 damage
        // itself.
        const protection = computeRoundTripProtection("1. one\n\t- child\n", "1. one\n   - child\n");

        expect(
            applyMinimalChanges(
                "1. one\n\t- child\n\n- a\n\t- b\n\t\t- c\n",
                "1. one\n   - child\n\n- a\n  - bQ\n    - c\n",
                protection,
            ),
        ).toBe("1. one\n\t- child\n\n- a\n\t- bQ\n\t\t- c\n");
    });

    it("an outline's fact should not speak for a fence line added after load", () => {
        // The loaded outline teaches `\t   ` -> four spaces. The user then adds
        // a fenced block containing a `\t   `-indented line and retypes it,
        // changing the indent AND the text. Fence content is verbatim user
        // bytes (MAR-161): the indent change is a real edit and must land.
        const protection = computeRoundTripProtection(SAVED, BASELINE);

        expect(
            applyMinimalChanges(
                "- a\n\t- b\n\t   - c\n\n```sh\n\t   echo hi\n```\n",
                "- a\n  - b\n    - c\n\n```sh\n    echo bye\n```\n",
                protection,
            ),
        ).toBe("- a\n\t- b\n\t   - c\n\n```sh\n    echo bye\n```\n");
    });

    it("a whitespace-only tab→space edit inside a fence should still register as an edit", () => {
        // The gate that outranks both rules: when the indent is the ONLY
        // difference, the indent IS the edit (MAR-161).
        const saved = "- alpha\n\t- beta\n\t   - gamma\n\n```sh\n\techo hi\n```\n";
        const baseline = "- alpha\n  - beta\n    - gamma\n\n```sh\n\techo hi\n```\n";
        const protection = computeRoundTripProtection(saved, baseline);

        expect(
            applyMinimalChanges(saved, "- alpha\n  - beta\n    - gamma\n\n```sh\n    echo hi\n```\n", protection),
        ).toBe("- alpha\n\t- beta\n\t   - gamma\n\n```sh\n    echo hi\n```\n");
    });
});

describe("applyMinimalChanges — a moved item takes the file's spelling of its NEW depth (MAR-299)", () => {
    // The pair the two carry rules refuse — whitespace the only difference — had
    // one answer too few. Refusing to write the SAVED bytes there is right
    // (MAR-161: the whitespace is the edit), but it was silently taken to mean
    // writing the SERIALIZER's, and a depth is named canonically by the
    // serializer and spelled its own way by the file. `respellMovedIndent` keeps
    // the depth and translates the spelling. movedBlockIndent.test.ts drives the
    // same two shapes through the real move gesture and the real save pipeline;
    // these are the distilled string-level pins, plus the two gates, which no
    // ordinary gesture reaches.

    it("an item outdented to a shallower depth should be spelled from its own saved bytes", () => {
        // A plain tab outline. It gets NO protection at all — a tab keys equal
        // to the two spaces it renders as, so the file round-trips under the
        // profile's own keys — which is exactly why the first arm consults no
        // facts: on this shape there are none to consult.
        const saved = "- alpha\n\t- beta\n\t\t- gamma\n\t- delta\n";
        expect(computeRoundTripProtection(saved, "- alpha\n  - beta\n    - gamma\n  - delta\n")).toBeNull();

        expect(applyMinimalChanges(saved, "- alpha\n  - beta\n  - gamma\n  - delta\n")).toBe(
            "- alpha\n\t- beta\n\t- gamma\n\t- delta\n",
        );
    });

    it("a file whose indent unit is wider than the serializer's should be spelled from the baseline", () => {
        // Four spaces per level. No prefix of the saved eight renders to the
        // serializer's two except two itself, so the line's own bytes cannot
        // answer and the baseline round trip, read backwards, has to.
        const saved = "- alpha\n    - beta\n        - gamma\n    - delta\n";
        const protection = computeRoundTripProtection(
            saved,
            "- alpha\n  - beta\n    - gamma\n  - delta\n",
        );
        expect(protection).not.toBeNull();

        expect(
            applyMinimalChanges(saved, "- alpha\n  - beta\n  - gamma\n  - delta\n", protection),
        ).toBe("- alpha\n    - beta\n    - gamma\n    - delta\n");
    });

    it("a re-spelling that does NOT move the depth is the user's own edit and must land", () => {
        // The gate that keeps MAR-161 closed against the new rule. Fence content
        // compares raw, so a whitespace-only edit inside a top-level fence
        // reaches the replacement hook — and unlike the Makefile line above,
        // `- item` looks exactly like a list marker, so the marker gate lets it
        // through. What refuses is the depth test: `\t` renders to precisely the
        // two spaces the serializer emitted, so nothing structural moved and the
        // difference is the user's own bytes.
        const saved = "```yaml\n\t- item\n```\n";
        const serialized = "```yaml\n  - item\n```\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(serialized);
    });

    it("a baseline naming a convention the file has abandoned should not be written back", () => {
        // The third gate, and the one the baseline arm cannot do without: those
        // facts are distilled ONCE at load and the saved text moves on after
        // every save, so the map can name a convention that is no longer in the
        // file at all. Here the document loaded as a tab outline — teaching that
        // the serializer's `  ` is written `\t` — and the user has since
        // converted the whole thing to spaces. Writing that `\t` back is four
        // columns where two are meant, which re-nests the outline exactly as the
        // bug this rule fixes does.
        //
        // The saved line's own indent is current by construction and settles it:
        // `    ` and `\t` share no prefix in either direction, so the fact is not
        // about this line and is declined.
        const protection = computeRoundTripProtection("- a\n\t- b\n\t   - c\n", "- a\n  - b\n    - c\n");
        expect(protection).not.toBeNull();

        expect(applyMinimalChanges("- a\n  - b\n    - c\n", "- a\n  - b\n  - c\n", protection)).toBe(
            "- a\n  - b\n  - c\n",
        );
    });

    it("a column-changing edit inside a fence must land verbatim, not be re-spelled (MAR-299)", () => {
        // The gate the first cut of rule 3 did not have, and the reason it was
        // reverted. Every other gate lets this through: `- item` passes the
        // marker test (fence content compares raw, so it reaches the hook at
        // all), the depth genuinely moved (no saved indent renders to the
        // serializer's two spaces), and the baseline arm has an answer ready —
        // the outline above teaches that two canonical columns are written
        // four. So the user's two spaces came back as four, inside a YAML block,
        // where the indent is what the document MEANS.
        //
        // Pinned line: the `if (!structural) return serial` gate in
        // `respellMovedIndent`. Delete it and this test reddens on its own.
        const saved = "- alpha\n    - beta\n\n```yaml\n- item\n```\n";
        const protection = computeRoundTripProtection(saved, "- alpha\n  - beta\n\n```yaml\n- item\n```\n");
        expect(protection).not.toBeNull();

        // The user typed two spaces before `- item`, inside the fence.
        expect(
            applyMinimalChanges(saved, "- alpha\n  - beta\n\n```yaml\n  - item\n```\n", protection),
        ).toBe("- alpha\n    - beta\n\n```yaml\n  - item\n```\n");
    });

    it("a whitespace-only outdent on a line that is not a list marker keeps the serializer's bytes", () => {
        // The other gate, and the reason `- item` above needed the depth test to
        // save it: this line's saved indent DOES pass through `\t` on its way
        // down to two columns, so the first arm has an answer ready. It is a
        // Makefile recipe, not an outline, and its leading whitespace is content
        // (MAR-161) — the marker gate is what declines to touch it.
        const saved = "```make\n\t\tgcc x\n```\n";
        const serialized = "```make\n  gcc x\n```\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(serialized);
    });
});

describe("applyMinimalChanges — a CRLF file with no trailing newline (MAR-223)", () => {
    // The corpus fixture ends with a newline, so the whole "unterminated final
    // segment" class is only covered by the engine's synthetic profile. These
    // two run the same shapes through the REAL markdown profile.
    it("appending should terminate the old last line with CRLF, not LF", () => {
        const saved = "# Title\r\n\r\nalpha\r\n\r\nomega"; // no final newline
        const merged = applyMinimalChanges(saved, "# Title\n\nalpha\n\nomega\n\ndelta\n");

        expect(merged).toBe("# Title\r\n\r\nalpha\r\n\r\nomega\r\n\r\ndelta\r\n");
    });

    it("editing the last line should not invent a trailing newline", () => {
        const saved = "# Title\r\n\r\nalpha\r\n\r\nomega";
        const merged = applyMinimalChanges(saved, "# Title\n\nalpha\n\nomega X\n");

        expect(merged).toBe("# Title\r\n\r\nalpha\r\n\r\nomega X");
    });
});

describe("applyMinimalChanges — list spread is structure, not spacing (MAR-293)", () => {
    // The merge's other two structure predicates ask whether a blank changes
    // the NEXT LINE's construct. Between two item markers it does not — `- b`
    // is a list item either way — but it changes the list's SPREAD, and a
    // loose list wraps every item's content in a paragraph while a tight one
    // does not. So the serializer's separating blank is structure here, and
    // the saved bytes' glue is a claim about the parse the editor overruled.
    it("a new sibling item in a loose list should keep the blank the serializer emits", () => {
        const saved = "bar\n\n- one\n\n- alpha\n  beta\n\n- three\n\nfoo\n";
        // The user split `alpha`/`beta` into two items. Only one significant
        // line changed (`  beta` → `- beta`), so this is an in-place
        // replacement and the saved spacing would otherwise win.
        const serialized = "bar\n\n- one\n\n- alpha\n\n- beta\n\n- three\n\nfoo\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(serialized);
    });

    // The split is on the LAST item deliberately. Splitting mid-list renumbers
    // every item below it, which changes more than one significant line and
    // marks the region dirty — and a dirty region takes the serializer's
    // spacing whatever the predicates say, so that shape passes with this rule
    // removed and pins nothing.
    it("the same shape with an ordered list should behave identically", () => {
        const saved = "bar\n\n1. one\n\n2. alpha\n   beta\n\nfoo\n";
        const serialized = "bar\n\n1. one\n\n2. alpha\n\n3. beta\n\nfoo\n";

        expect(applyMinimalChanges(saved, serialized)).toBe(serialized);
    });

    // The conservatism the rule is built around: it fires only between lines
    // that could be consecutive items of ONE list. Everything below carries a
    // marker and is NOT a sibling, so the saved bytes must survive untouched —
    // firing on any of them would churn blank runs in files the user never
    // edited there.
    it.each([
        ["a different bullet character starts a new list", "- a\n* b\n", "- a\n\n* b\n"],
        ["a sublist is a different list", "- a\n  - b\n", "- a\n\n  - b\n"],
        ["a different ordered delimiter starts a new list", "1. a\n2) b\n", "1. a\n\n2) b\n"],
        // `- - -` matches the marker shape but a thematic break takes
        // precedence over an item, so it is nobody's sibling.
        ["a thematic break is not an item", "- a\n- - -\n", "- a\n\n- - -\n"],
    ])("%s, so the saved glue should survive", (_name, saved, serialized) => {
        expect(applyMinimalChanges(saved, serialized)).toBe(saved);
    });
});
