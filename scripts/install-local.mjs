#!/usr/bin/env node
// One-shot local install: test → package → install → clear legacy copies →
// verify exactly one copy remains. This is the AGENTS.md end-of-work handoff
// (steps 1–5) as a single command so trying a build in your own VS Code window
// takes zero manual steps. The only thing left to you is the window reload
// (Cmd+Shift+P → "Developer: Reload Window"), which the script can't do for you.
//
// Usage: pnpm run install:local
//
// It never touches your settings.json — every install/uninstall below leaves
// your birta.* config untouched, so it carries across reinstalls.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const VSIX = "releases/birta-writer-0.0.0.vsix";
const CURRENT_ID = "birtalabs.birta-writer";
// Pre-org / pre-rebrand ids. Removing these guarantees VS Code never runs two
// copies of this editor over the same .md files.
const LEGACY_IDS = ["harlanlewis.birta-writer", "harlanlewis.md-wysiwyg-editor"];

// The VS Code `code` CLI is often not on PATH on macOS even when VS Code is
// installed — fall back to the app-bundle binary before giving up.
const CODE_FALLBACK =
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";

function step(msg) {
    console.log(`\n→ ${msg}`);
}

// Run a command, streaming its output. Throws on non-zero exit.
function run(cmd, args) {
    execFileSync(cmd, args, { stdio: "inherit" });
}

// Run a command and capture stdout; returns null on non-zero exit instead of
// throwing (used for the code-CLI probe and the tolerant uninstall). stderr is
// suppressed so the expected "extension is not installed" hint — the common,
// harmless case when there's no legacy copy to remove — doesn't spew a scary
// "use the full extension ID" block; the final single-copy check is the gate.
function tryCapture(cmd, args) {
    try {
        return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
        return null;
    }
}

function resolveCodeCli() {
    if (tryCapture("code", ["--version"]) !== null) return "code";
    if (existsSync(CODE_FALLBACK) && tryCapture(CODE_FALLBACK, ["--version"]) !== null) {
        return CODE_FALLBACK;
    }
    return null;
}

// 1. Tests must be green before anything ships to the editor.
step("pnpm test");
run("pnpm", ["test"]);

// 2. Package the VSIX (this also runs the check-vsix tripwire).
step("pnpm run package");
run("pnpm", ["run", "package"]);
if (!existsSync(VSIX)) {
    console.error(`install-local: expected ${VSIX} after packaging, but it is missing.`);
    process.exit(1);
}

// 3. Install into VS Code, clearing out any legacy copy so only one runs.
const code = resolveCodeCli();
if (code === null) {
    console.log(
        "\ninstall-local: VS Code `code` CLI not found (PATH or app bundle) — " +
            `built and packaged ${VSIX}, but skipped install. Install VS Code, or ` +
            `run: code --install-extension ${VSIX} --force`,
    );
    process.exit(0);
}

step(`installing ${VSIX} (${code === "code" ? "code on PATH" : "app-bundle binary"})`);
run(code, ["--install-extension", VSIX, "--force"]);

step("removing legacy copies (ignore \"not installed\")");
for (const id of LEGACY_IDS) {
    // Tolerate "not installed" — it just means the cleanup already happened.
    const out = tryCapture(code, ["--uninstall-extension", id]);
    if (out !== null) process.stdout.write(out);
}

// 4. Verify exactly one copy of this editor remains.
step("verifying a single installed copy");
const listing = tryCapture(code, ["--list-extensions"]) ?? "";
const copies = listing
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /birta|wysiwyg/i.test(l));

if (copies.length === 1 && copies[0] === CURRENT_ID) {
    console.log(`  OK — only ${CURRENT_ID} is installed.`);
} else {
    console.error(
        `install-local: expected only ${CURRENT_ID}, but found: ${
            copies.length ? copies.join(", ") : "(none)"
        }`,
    );
    process.exit(1);
}

console.log(
    "\n✓ Installed. Reload to run the new build: " +
        'Cmd+Shift+P → "Developer: Reload Window".',
);
