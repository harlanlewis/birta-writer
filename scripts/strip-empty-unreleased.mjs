// Remove an EMPTY `## [Unreleased]` section from CHANGELOG.md.
//
// The repository needs that heading: it is where contributors write, and
// stamp-changelog.mjs looks for it by name. A reader of the Marketplace
// Changelog tab does not. After a release stamps, the shipped file opens on an
// empty "Unreleased" heading wrapped in horizontal rules, above the version
// they actually installed, which is a contributor marker leaking into a
// user-facing document.
//
// So the release job strips it from the copy that goes into the VSIX and
// restores the repository copy immediately after packaging.
//
// Only ever removes an EMPTY section. If `[Unreleased]` has content, something
// has gone wrong with the ordering (this must run after the stamp, never
// before) and dropping real entries would be silent data loss, so it exits
// non-zero instead.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = process.argv[2] ?? "CHANGELOG.md";
const text = readFileSync(FILE, "utf8");

const start = text.indexOf("\n## [Unreleased]");
if (start === -1) {
    console.log("strip-empty-unreleased: no [Unreleased] section; nothing to do.");
    process.exit(0);
}

// The section runs to the next `## ` heading at line start.
const after = text.indexOf("\n## ", start + 1);
const end = after === -1 ? text.length : after;
const body = text.slice(start + "\n## [Unreleased]".length, end);

// Empty means: no content but whitespace and the `---` rule the file puts
// between sections.
if (body.replace(/^\s*---\s*$/gm, "").trim() !== "") {
    console.error(
        "strip-empty-unreleased: [Unreleased] is not empty. This runs AFTER " +
            "stamp-changelog.mjs; removing it here would drop real entries.",
    );
    process.exit(1);
}

// Take the heading and its body, leaving the `---` that preceded it to serve as
// the separator above the version heading that follows.
writeFileSync(FILE, text.slice(0, start) + text.slice(end), "utf8");
console.log(`strip-empty-unreleased: removed the empty [Unreleased] section from ${FILE}.`);
