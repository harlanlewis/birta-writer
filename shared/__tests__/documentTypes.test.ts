/**
 * Guard for the file types Birta Writer for Mac claims: `Info.plist`, Swift and
 * `shared/documentExtensions.ts` agree about them.
 *
 * `DOCUMENT_EXTENSIONS` is the list, and `documentExtensions.test.ts` already
 * holds every TypeScript caller to it, `editorSelectorParity.test.ts` holds the
 * extension manifest's `customEditors` selector to it, and neither looks at the
 * Mac app at all. That scan reads `.ts` and `.mjs` under six directories, so
 * Swift and a property list were outside every copy-detector in the repository:
 * exactly the shape AGENTS.md names, a guard that is ABSENT rather than wrong,
 * invisible to every green run.
 *
 * Three copies, related here because none of the three can import another.
 * `Info.plist`'s `CFBundleDocumentTypes` is what Launch Services reads, so it
 * decides which files offer this app in Open With at all;
 * `BirtaWriterCore.DocumentTypes.opened` is what the app checks when a file
 * arrives, since `open -a` consults no plist. Drift is silent in both
 * directions and neither side can see it: an extension in Swift alone never
 * reaches the app from the Finder, and one in the plist alone is a file macOS
 * hands over and the app turns away.
 *
 * What is deliberately NOT claimed: that these are the only extensions the
 * Finder will offer this app for. `net.daringfireball.markdown` is a type macOS
 * declares itself, with more tags on it than the two imported below, and the
 * system's declaration is the one that wins. This file relates what we DECLARE,
 * which is the part a change to this repository can break.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parsePlist, plistDicts, plistStrings, type PlistDict } from "./plist";
import { DOCUMENT_EXTENSIONS } from "../documentExtensions";

const REPO = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

const plist = parsePlist(read("mac/Resources/Info.plist"));
const documentTypes = read("mac/Sources/BirtaWriterCore/DocumentTypes.swift");
const noteTemplate = read("mac/Sources/BirtaWriterCore/NoteNameTemplate.swift");

const sorted = (values: readonly string[]) => [...values].sort();
const expected = sorted(DOCUMENT_EXTENSIONS);

/** A `static let name = ["a", "b"]` in Swift, as its strings. */
function swiftList(source: string, name: string): string[] {
    const body = new RegExp(`static let ${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source)?.[1];
    if (body === undefined) throw new Error(`no static let ${name} array in the Swift source`);
    return [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
}

/** A `static let name = "value"` in Swift. */
function swiftString(source: string, name: string): string {
    const value = new RegExp(`static let ${name}\\s*=\\s*"([^"]*)"`).exec(source)?.[1];
    if (value === undefined) throw new Error(`no static let ${name} string in the Swift source`);
    return value;
}

/** The type identifiers each `CFBundleDocumentTypes` entry claims. */
const claimed = plistDicts(plist, "CFBundleDocumentTypes").map((entry) => ({
    entry,
    types: plistStrings(entry, "LSItemContentTypes"),
}));

/** The types the bundle describes for itself, by identifier. */
const imported = new Map<string, PlistDict>(
    plistDicts(plist, "UTImportedTypeDeclarations").map((declaration) => {
        const id = declaration.UTTypeIdentifier;
        if (typeof id !== "string") throw new Error("an imported type has no UTTypeIdentifier");
        return [id, declaration];
    }),
);

/** The filename extensions one imported declaration tags. */
function taggedExtensions(declaration: PlistDict): string[] {
    const spec = declaration.UTTypeTagSpecification;
    if (typeof spec !== "object" || Array.isArray(spec)) {
        throw new Error("an imported type has no UTTypeTagSpecification");
    }
    return plistStrings(spec, "public.filename-extension");
}

describe("the Mac app's document types", () => {
    it("should claim types the bundle itself describes, so the extensions are derivable", () => {
        // The plist is the copy that cannot import anything, so the check below
        // can only compare extensions if every type this app claims is also
        // spelled out here with its tags. A type claimed and not described is a
        // claim about a system declaration that this repository cannot see.
        expect(claimed.length, "document types declared").toBeGreaterThan(0);
        expect(imported.size, "imported type declarations").toBe(claimed.length);
        for (const { types } of claimed) {
            expect(types.length, "a document type claims no content type").toBeGreaterThan(0);
            for (const id of types) {
                expect([...imported.keys()], `${id} is claimed but not described`).toContain(id);
            }
        }
        const allClaimed = new Set(claimed.flatMap((c) => c.types));
        for (const id of imported.keys()) {
            expect([...allClaimed], `${id} is described but no document type claims it`).toContain(id);
        }
    });

    it("should declare exactly the extensions the editor opens", () => {
        const declared = [...imported.values()].flatMap(taggedExtensions);
        // No duplicates: two types tagging the same extension is two entries in
        // the Finder's Open With for one file, and the set comparison below
        // cannot see it.
        expect(sorted(declared), "an extension is tagged twice").toEqual([...new Set(declared)].sort());
        expect(sorted(declared)).toEqual(expected);
    });

    it("should join the Open With list without taking the default away", () => {
        // `Alternate` is the whole request: this app offers itself for a
        // Markdown file, it does not become what double-clicking one opens.
        // `Owner` or a missing rank would make a fresh install silently take
        // over every .md on the machine.
        for (const { entry, types } of claimed) {
            expect(entry.LSHandlerRank, `${types.join(", ")} handler rank`).toBe("Alternate");
            expect(entry.CFBundleTypeRole, `${types.join(", ")} role`).toBe("Editor");
        }
    });

    it("Swift should accept exactly the extensions the plist offers it", () => {
        expect(sorted(swiftList(documentTypes, "opened"))).toEqual(expected);
    });

    it("the extension the app writes should be one it can open again", () => {
        // The two lists are deliberately different sizes, so the relation
        // between them has to be stated: every file this app creates is one
        // Open With will offer it back.
        const written = swiftString(noteTemplate, "ext");
        expect(DOCUMENT_EXTENSIONS as readonly string[]).toContain(written);
        expect(documentTypes).toContain("written = NoteNameTemplate.ext");
    });

    it("no other Swift file should spell an extension for itself", () => {
        // The sibling of `documentExtensions.test.ts`'s last case, for the half
        // of the tree it cannot read. Six Swift call sites spelled `"md"` by
        // hand before this, each one a list that goes out of step on the day a
        // format is added.
        //
        // Comments are stripped first: a sentence explaining why a list is
        // narrow is prose about the decision, not a second copy of it.
        const dir = join(REPO, "mac/Sources");
        const files = [
            ...readdirSync(join(dir, "BirtaWriter")).map((f) => join(dir, "BirtaWriter", f)),
            ...readdirSync(join(dir, "BirtaWriterCore")).map((f) => join(dir, "BirtaWriterCore", f)),
        ].filter((f) => f.endsWith(".swift"));
        expect(files.length, "Swift files scanned").toBeGreaterThan(50);

        // The two declarations themselves, which are what everything else now
        // reads. Nothing else may hold a literal.
        const declarers = ["DocumentTypes.swift", "NoteNameTemplate.swift"];
        const literal = new RegExp(`"(?:${DOCUMENT_EXTENSIONS.join("|")})"`);
        expect(literal.test('let ext = "md"'), "the pattern can fire").toBe(true);

        const offenders: string[] = [];
        for (const file of files) {
            if (declarers.some((d) => file.endsWith(d))) continue;
            const code = readFileSync(file, "utf8")
                .split("\n")
                .filter((line) => !line.trimStart().startsWith("//"))
                .join("\n");
            if (literal.test(code)) offenders.push(file.slice(REPO.length + 1));
        }
        expect(offenders, "read DocumentTypes instead").toEqual([]);
    });
});
