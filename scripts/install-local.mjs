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
// Casing matches the Marketplace publisher id exactly (`BirtaLabs`). VS Code
// resolves extension ids case-insensitively, so this is about staying honest to
// the registry, not about the CLI caring.
const CURRENT_ID = "BirtaLabs.birta-writer";
// The app this handoff installs, spelled once. `jot/scripts/build-app.sh`
// composes the same name from the flavour suffix in `AppFlavor.swift`, and
// nothing relates a printed string to a bundle on disk, so a rename left six
// messages here naming an app that no longer existed. `appFlavor.test.ts`
// holds this literal to the composed name.
const JOT_APP_NAME = "Birta Writer Jot [DEV]";
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

/**
 * Build and install Birta Writer Jot too, so the handoff leaves BOTH surfaces running
 * the tree the session just finished. Jot embeds dist/webview.js, which
 * packaging above has already produced in production form, so this only builds
 * the Swift shell and swaps the app.
 *
 * Unconditional on macOS by design. Almost every change that reaches the editor
 * reaches Jot, since it is the same bundle; a rule for deciding when to skip
 * would be one more thing to get wrong, and a stale Jot is invisible until you
 * summon it and find yesterday's build.
 *
 * Skipped rather than failed when the machine cannot do it: Jot is macOS-only,
 * and Swift is not everywhere. The extension install is the part that must not
 * be held up by a missing toolchain.
 */
function installJot() {
    if (process.platform !== "darwin") {
        console.log(`\ninstall-local: not macOS, so ${JOT_APP_NAME} was skipped (it is a macOS app).`);
        return;
    }
    if (tryCapture("swift", ["--version"]) === null) {
        console.log(
            `\ninstall-local: no \`swift\` on PATH, so ${JOT_APP_NAME} was skipped. ` +
                "Install the Xcode Command Line Tools, then: pnpm jot:install",
        );
        return;
    }
    step(`building and installing ${JOT_APP_NAME}`);
    try {
        // The DEVELOPMENT flavour, and it must stay that way: the handoff
        // never touches the release copy, which is the one holding somebody's
        // notes. The two coexist through a separate bundle id, defaults
        // domain, note, and hotkey, and the development one never updates
        // itself. `BirtaJotCore.AppFlavor` holds that list.
        run("bash", ["jot/scripts/install-app.sh", "--build", "--dev"]);
    } catch {
        // A refusal here is usually a running copy that would not quit, which
        // the script explains on its own. The extension is already installed by
        // this point and that must not be reported as a failure.
        console.log(
            `install-local: ${JOT_APP_NAME} was not replaced (see the message above). ` +
                "The extension install above is unaffected; re-run `pnpm jot:install` when ready.",
        );
    }
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
    installJot();
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

// Compare case-insensitively: extension ids are case-insensitive to VS Code, and
// `--list-extensions` prints them lowercased regardless of the publisher's own
// casing — so an exact match against `BirtaLabs.birta-writer` always fails here.
if (copies.length === 1 && copies[0].toLowerCase() === CURRENT_ID.toLowerCase()) {
    console.log(`  OK — only ${CURRENT_ID} is installed (listed as ${copies[0]}).`);
} else {
    console.error(
        `install-local: expected only ${CURRENT_ID}, but found: ${
            copies.length ? copies.join(", ") : "(none)"
        }`,
    );
    process.exit(1);
}

// 5. Install the development flavour of Jot, the macOS shell, from the same build.
installJot();

console.log(
    "\n✓ Installed. Reload to run the new build: " +
        'Cmd+Shift+P → "Developer: Reload Window".' +
        `\n  ${JOT_APP_NAME} needs no reload: it was replaced and relaunched if it was running.\n` +
        "  It sits beside the release copy and keeps its own note, hotkey and settings.",
);
