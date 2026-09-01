/**
 * The frontmatter block's definition, held across the two languages that
 * declare it.
 *
 * `extractFrontmatter` (shared/contentTransform.ts) is the source: it decides
 * what the extension calls metadata and what it calls body. The Mac app is the
 * second host and cannot import it, so `Frontmatter.split` restates the pattern
 * in Swift. Both surfaces open the same files, so the two disagreeing is not a
 * cosmetic drift: it is a file whose bytes move when it is opened on one side
 * and not the other.
 *
 * `FrontmatterTests` mirrors `contentTransform.test.ts` case for case, which
 * catches a Swift pattern that behaves differently on any case somebody thought
 * of. This catches the rest, by comparing the patterns themselves, and it is
 * the check the two headers' "down to the pattern string" claim needs in order
 * to be a contract rather than an intention.
 *
 * The extraction is self-validating. A guard that reads a source file by regex
 * can quietly match nothing, or match the wrong literal, and then it passes
 * having compared two things it invented; so the string pulled out of the
 * TypeScript is rebuilt into a `RegExp` and required to split a corpus exactly
 * as the live `extractFrontmatter` does. If that fails, the extraction is
 * broken and the comparison below means nothing.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { extractFrontmatter } from "../contentTransform";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TS_PATH = "shared/contentTransform.ts";
const SWIFT_PATH = "mac/Sources/BirtaWriterCore/Frontmatter.swift";

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** The pattern literal `extractFrontmatter` matches with. */
function tsPattern(): string {
    const match = /content\.match\(\/(.+?)\/\)/.exec(read(TS_PATH));
    if (match === null) {
        throw new Error(`no \`content.match(/.../)\` call found in ${TS_PATH}; this guard must follow it`);
    }
    return match[1]!;
}

/** The pattern string `Frontmatter.split` matches with, out of its raw literal. */
function swiftPattern(): string {
    const match = /pattern: #"(.+?)"#\)/.exec(read(SWIFT_PATH));
    if (match === null) {
        throw new Error(`no \`pattern: #"..."#\` literal found in ${SWIFT_PATH}; this guard must follow it`);
    }
    return match[1]!;
}

/**
 * Enough shapes to tell one pattern from a near neighbour: both dialects, a
 * mismatched pair, an inner line that merely starts with the delimiter, CRLF,
 * a fence at end of file, and a block that is not at the start.
 */
const CORPUS = [
    "---\ntitle: A\n---\n# Body",
    "---\ntitle: A\n--- draft\n----\n---\n# Body",
    "---\ntitle: A\n+++\n# Body",
    "---\r\ntitle: A\r\n---\r\n# Body",
    "---\ntitle: A\n---",
    "---\n---\n# Body",
    '+++\ntitle = "A"\n+++\n# Body',
    '+++\ntitle = "A"\n---\nmore = "x"\n+++\n# Body',
    '+++\ntitle = "A"\n# Body',
    'Some text\n+++\ntitle = "A"\n+++\n',
    "# Just a heading\n\nSome text.",
    "",
];

describe("the frontmatter pattern across TypeScript and Swift", () => {
    it("the pattern read out of the TypeScript should behave as extractFrontmatter does", () => {
        const rebuilt = new RegExp(tsPattern());
        // A corpus that reached nothing would agree with anything, so the split
        // has to actually happen somewhere: most of these are blocks.
        expect(CORPUS.filter((c) => extractFrontmatter(c).frontmatter !== "").length).toBeGreaterThan(5);
        for (const content of CORPUS) {
            expect(content.match(rebuilt)?.[0] ?? "", content).toBe(extractFrontmatter(content).frontmatter);
        }
    });

    it("the Swift port should carry the same pattern, character for character", () => {
        expect(swiftPattern()).toBe(tsPattern());
    });
});
