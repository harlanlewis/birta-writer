/**
 * Direct tests for the fence contract in shared/frontmatterTable.ts.
 *
 * splitFences is exported and has a contract of its own, but every existing
 * caller reaches it through parseTabularFrontmatter, which refuses a non-YAML
 * dialect before the fences matter. That masking is why the closer-repeats-the-
 * opener rule needs a test here rather than one tier up.
 */
import { describe, it, expect } from "vitest";
import { splitFences } from "../frontmatterTable";

describe("splitFences", () => {
    it("a YAML block should split into fences, inner text and the --- delimiter", () => {
        expect(splitFences("---\ntitle: A\n---\n")).toEqual({
            prefix: "---\n",
            inner: "title: A",
            suffix: "\n---\n",
            delimiter: "---",
        });
    });

    it("a TOML block should split into fences, inner text and the +++ delimiter", () => {
        expect(splitFences('+++\ntitle = "A"\n+++\n')).toEqual({
            prefix: "+++\n",
            inner: 'title = "A"',
            suffix: "\n+++\n",
            delimiter: "+++",
        });
    });

    it("a block opened +++ and closed --- should not split", () => {
        // The closing fence must repeat the opener. Accepting a mismatched pair
        // would hand a caller a prefix and suffix in different dialects, and the
        // raw editor writes both back verbatim around the user's text.
        expect(splitFences('+++\ntitle = "A"\n---\n')).toBeNull();
    });

    it("a block opened --- and closed +++ should not split", () => {
        expect(splitFences("---\ntitle: A\n+++\n")).toBeNull();
    });

    it("a CRLF TOML block should split and keep its line endings in the fences", () => {
        expect(splitFences('+++\r\ntitle = "A"\r\n+++\r\n')).toEqual({
            prefix: "+++\r\n",
            inner: 'title = "A"',
            suffix: "\r\n+++\r\n",
            delimiter: "+++",
        });
    });

    it("a closing fence with no trailing newline should still split", () => {
        expect(splitFences('+++\ntitle = "A"\n+++')).toEqual({
            prefix: "+++\n",
            inner: 'title = "A"',
            suffix: "\n+++",
            delimiter: "+++",
        });
    });

    it("text that is not a fenced block should not split", () => {
        expect(splitFences("title: A\n")).toBeNull();
    });
});
