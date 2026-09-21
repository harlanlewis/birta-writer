#!/usr/bin/env node
/**
 * Enumerate every place the extension half depends on its host being Node,
 * and give each occurrence a verdict about running under a `browser` entry
 * point instead: the VS Code web extension host, a WebWorker with no Node at
 * all. `docs/NODE_COUPLINGS.md` is the write-up; this file is where its
 * numbers come from, so nothing there prints a count.
 *
 * Two halves, deliberately kept apart, the same shape as
 * `scripts/audit-page-ownership.mjs`:
 *
 *   SCAN. Broad, and it knows nothing about the verdicts. It finds candidate
 *   sites by shape alone: an import of a Node builtin, a Node global, a `.fsPath`,
 *   a `file:` URL or scheme test, and the two `fetch` shapes a browser treats
 *   differently from Node's.
 *
 *   RULES. A table keyed by the scan's `kind` plus a refinement (the module
 *   name, the global's spelling, the header name). Whatever no rule recognizes
 *   is RESIDUE and is printed by name.
 *
 * The separation is the point. If the rules did the finding, "every coupling
 * has a verdict" would be true by construction. Because the scan is broader
 * than the table, a coupling arriving in the tree shows up as residue rather
 * than being quietly sorted into a bucket that was never asked about it.
 *
 * Why the two `fetch` shapes are in an audit named for Node. They are Node
 * couplings that are not import-shaped: `user-agent` is a forbidden header
 * name in the Fetch standard, which Node's fetch honours and a browser's does
 * not, and a readable `Location` on a `redirect: "manual"` response is a Node
 * behaviour that a browser replaces with an opaque filtered response. Both are
 * places the code depends on being in Node without saying so in an import, and
 * both fail silently rather than loudly, which is the class this audit exists
 * for.
 *
 * What this cannot see, and how to see it. The scan reads this repository's own
 * TypeScript, so a coupling inside a DEPENDENCY is invisible to it. The one
 * that matters is real: harper.js reaches for `fs` from its own wasm loader.
 * `--check` cross-reads `dist/extension.meta.json` when a metafile build has
 * left one, and every builtin the built bundle requires that the source scan
 * did not account for must be named in DEPENDENCY_COUPLINGS with a reason.
 * With no metafile present it says so by name rather than passing in silence.
 *
 * Usage:
 *   node scripts/audit-node-couplings.mjs                 report, grouped by verdict
 *   node scripts/audit-node-couplings.mjs --by-capability  report, grouped by capability
 *   node scripts/audit-node-couplings.mjs --by-kind        report, grouped by kind
 *   node scripts/audit-node-couplings.mjs --list           every occurrence, one per line
 *   node scripts/audit-node-couplings.mjs --json           the whole thing as JSON
 *   node scripts/audit-node-couplings.mjs --check          exit nonzero on residue or a floor miss
 *
 * The metafile the cross-check wants is written by:
 *   node esbuild.mjs --production --metafile
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["src", "shared", "packages"];
const METAFILE = join(ROOT, "dist", "extension.meta.json");

// ─── Verdicts ────────────────────────────────────────────────────────────────

/**
 * SURVIVES  A web build keeps the behaviour, at the cost of at most a
 *           mechanical substitution: Web Crypto for Node crypto, TextDecoder
 *           for Buffer, string arithmetic over `uri.path` for `path`. Nothing
 *           a user could point at changes.
 *
 * DEGRADES  A web build keeps the capability and loses something: a guarantee,
 *           a case, a form of input that stops resolving. This is the bucket
 *           that matters, because every one of these is a place the editor
 *           would go on looking like it worked.
 *
 * DROPS     A web build cannot have this. The capability is absent and has to
 *           be gated off rather than degraded, or the surface ships without it.
 */
const SURVIVES = "survives";
const DEGRADES = "degrades";
const DROPS = "drops";
export const VERDICTS = [SURVIVES, DEGRADES, DROPS];

/**
 * The product capability an occurrence belongs to. A verdict is only useful
 * to a maintainer once it is attached to a thing a user would notice, so every
 * rule names one and `--by-capability` is how the per-feature answer is read.
 */
export const CAPABILITIES = [
    "proofreading",
    "unfurl",
    "embeds",
    "connectors",
    "images",
    "external-changes",
    "agent-bridge",
    "export",
    "links",
    "chrome",
    "feedback",
    /**
     * Not a capability: a tax spread across all of them. Buffer conversions,
     * process.platform, and the two path families belong to no one feature, and
     * labelling them with whichever feature a given line happens to sit in
     * would make the per-capability table read worse than it is.
     */
    "cross-cutting",
];

// ─── What the scan deliberately does not collect ─────────────────────────────

const NOT_COLLECTED = [
    ["the webview bundle", "webview/ is a browser page under every host it already has, so it has no Node to lose. `node esbuild.mjs --metafile` then reading dist/webview.meta.json is the measurement, and it is the reason this scan stops at the extension half."],
    ["test files", "__tests__ and src/test/ run under Node by construction. A coupling there says nothing about what a browser entry point would ship."],
    ["type-only imports", "`import type` is erased before the bundle exists, so it cannot be a runtime coupling. The scan drops a line whose import is spelled `import type`."],
    ["comment-only lines", "a line whose trimmed form starts with //, /* or * is dropped before the patterns run, so prose about `child_process` is not an occurrence."],
    ["dependencies", "a coupling inside node_modules is invisible to a scan of this tree. --check reads the built metafile for those; see DEPENDENCY_COUPLINGS."],
];

// ─── Scan ────────────────────────────────────────────────────────────────────

/** Node builtins, in both spellings. `node:` is stripped so one rule covers both. */
const BUILTINS = [
    "assert", "buffer", "child_process", "cluster", "crypto", "dgram", "dns", "dns/promises",
    "events", "fs", "fs/promises", "http", "http2", "https", "module", "net", "os", "path",
    "path/posix", "perf_hooks", "process", "querystring", "readline", "stream", "stream/promises",
    "string_decoder", "timers", "timers/promises", "tls", "tty", "url", "util", "v8", "vm",
    "worker_threads", "zlib",
];
const BUILTIN_RE = BUILTINS.map((b) => b.replace(/\//g, "\\/")).join("|");

const PATTERNS = [
    {
        kind: "builtin-import",
        re: new RegExp(String.raw`(?:from\s*|import\(\s*|require\(\s*)["'](?:node:)?(${BUILTIN_RE})["']`, "g"),
        refine: (m) => m[1],
    },
    {
        kind: "node-global",
        re: /(?<![.\w$])(process\.\w+|Buffer|__dirname|__filename)/g,
        refine: (m) => (m[1].startsWith("process.") ? m[1] : m[1]),
    },
    { kind: "os-path", re: /\.fsPath\b/g, refine: () => "fsPath" },
    { kind: "file-uri", re: /(Uri\.file\(|pathToFileURL\(|["'`]file:\/\/)/g, refine: (m) => m[1].replace(/[("'`]/g, "") },
    { kind: "file-scheme", re: /scheme\s*(===|!==)\s*["']file["']/g, refine: (m) => (m[1] === "===" ? "eq" : "ne") },
    { kind: "forbidden-header", re: /["'](user-agent|referer|origin|cookie|host|connection)["']\s*:/gi, refine: (m) => m[1].toLowerCase() },
    { kind: "manual-redirect", re: /redirect:\s*["'](manual|follow|error)["']/g, refine: (m) => m[1] },
];

/** A line that is only a comment cannot be an occurrence. Conservative: it never drops code. */
function isCommentLine(line) {
    const t = line.trim();
    return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/");
}

/** `import type { X } from "fs"` is erased at build time and ships nothing. */
function isTypeOnlyImport(line) {
    return /^\s*import\s+type\b/.test(line) || /^\s*export\s+type\b/.test(line);
}

function isProductFile(rel) {
    if (rel.includes("__tests__")) return false;
    if (rel.includes("__fixtures__")) return false;
    if (rel.startsWith("src/test/")) return false;
    if (rel.endsWith(".test.ts") || rel.endsWith(".d.ts")) return false;
    return rel.endsWith(".ts");
}

function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

export function scan() {
    const occurrences = [];
    let files = 0;
    for (const dir of SCAN_DIRS) {
        const abs = join(ROOT, dir);
        if (!existsSync(abs)) continue;
        for (const full of walk(abs)) {
            const rel = relative(ROOT, full).split("\\").join("/");
            if (!isProductFile(rel)) continue;
            files += 1;
            const lines = readFileSync(full, "utf8").split("\n");
            lines.forEach((line, i) => {
                if (isCommentLine(line) || isTypeOnlyImport(line)) return;
                for (const { kind, re, refine } of PATTERNS) {
                    re.lastIndex = 0;
                    let m;
                    while ((m = re.exec(line)) !== null) {
                        occurrences.push({
                            file: rel,
                            line: i + 1,
                            kind,
                            refinement: refine(m),
                            text: line.trim().slice(0, 140),
                        });
                    }
                }
            });
        }
    }
    return { files, occurrences };
}

// ─── Rules ───────────────────────────────────────────────────────────────────

/**
 * Keyed `kind/refinement`, optionally narrowed by file. A rule carries the
 * verdict, the capability it belongs to, and the argument for the verdict.
 * The argument is the part worth reading; the verdict on its own is a label.
 *
 * `file` narrows a rule to one module, which is needed wherever the same shape
 * means different things in different places: `path.basename` on a name and
 * `path.join(os.homedir(), …)` are both `builtin-import/path` and only one of
 * them survives.
 */
const RULES = [
    // ── Node builtins, by the module and by who imports it ────────────────
    {
        key: "builtin-import/fs", file: "src/keybindings.ts", verdict: DROPS, capability: "chrome",
        why: "Reads keybindings.json and globalStorage/storage.json out of the user-data directory, which no FileSystemProvider on the web serves and no VS Code API exposes. The module's own doctrine is that an unanswerable lookup returns nothing rather than a guess, so a web build returns no chords and every tooltip prints a bare label.",
    },
    {
        key: "builtin-import/path", file: "src/keybindings.ts", verdict: DROPS, capability: "chrome",
        why: "Only ever joins segments of the user-data directory that the fs read above cannot reach, so it goes when that goes rather than on its own account.",
    },
    {
        key: "builtin-import/child_process", verdict: DROPS, capability: "agent-bridge",
        why: "Spawning a harness binary and probing its --help. A WebWorker has no process table and the host it runs on has no shell of the user's, so the background and terminal routes of /ai are absent rather than degraded. The chat and clipboard routes need no child and are unaffected.",
    },
    {
        key: "builtin-import/os", file: "src/agentBridge/askAgent.ts", verdict: DROPS, capability: "agent-bridge",
        why: "tmpdir() picks a scratch directory for a dropped attachment whose whole purpose is to be a path a locally running CLI can open. With no local CLI there is nothing for the path to mean.",
    },
    {
        key: "builtin-import/os", file: "src/utils/imageService.ts", verdict: DEGRADES, capability: "images",
        why: "homedir() is the fallback target for a document whose scheme is not file:, which on the web is every document. A web build has to pick another target (globalStorageUri is the obvious one) and saved images then land somewhere the reader did not choose.",
    },
    {
        key: "builtin-import/os", file: "src/webviewHtml.ts", verdict: DEGRADES, capability: "chrome",
        why: "homedir() expands a leading ~ in the custom CSS and JS setting. A web build keeps the workspace-relative and ${workspaceFolder} forms and the ~ and absolute forms stop resolving, which the function already absorbs by returning undefined.",
    },
    {
        key: "builtin-import/net", verdict: SURVIVES, capability: "unfurl",
        why: "isIP is a pure predicate over a string with no I/O, so a hand-written validator reproduces it exactly. It has to be at least as permissive as Node about what counts as a literal, because anything it fails to recognise falls into the hostname branch, which on the web has no DNS check behind it.",
    },
    {
        key: "builtin-import/dns/promises", verdict: DROPS, capability: "unfurl",
        why: "The lookup is the only thing standing between a publicly registered hostname that resolves into private space (127.0.0.1.nip.io and its kind) and a request from inside the user's network. A browser exposes no DNS and no hook below fetch that could see a resolved address, so the check cannot be ported in any form.",
    },
    {
        key: "builtin-import/crypto", file: "src/utils/getNonce.ts", verdict: SURVIVES, capability: "chrome",
        why: "randomBytes(16) for a CSP nonce. crypto.getRandomValues is the same CSPRNG, synchronous, and present in a worker, so one implementation serves both entry points.",
    },
    {
        key: "builtin-import/crypto", file: "src/connectors/pkce.ts", verdict: DEGRADES, capability: "connectors",
        why: "randomBytes and the SHA-256 of the PKCE challenge port exactly onto getRandomValues and subtle.digest, the second at the cost of becoming async. timingSafeEqual is the one with no Web Crypto counterpart: a constant-time comparison stops being something the platform vouches for and becomes something the code has to argue for, by an accumulate-XOR loop or by hashing both sides first.",
    },
    {
        key: "builtin-import/crypto", file: "src/utils/imageService.ts", verdict: DEGRADES, capability: "images",
        why: "The dedup key is an MD5, and subtle.digest offers no MD5. The digest is compared in memory and never written anywhere, so switching it to SHA-256 preserves the behaviour, but the call sites change shape because subtle.digest is async where createHash is not.",
    },
    {
        key: "builtin-import/url", file: "src/utils/harperService.ts", verdict: DEGRADES, capability: "proofreading",
        why: "pathToFileURL builds the file: URL harper.js is handed for its wasm. On the web the wasm has to arrive as an https URL under extensionUri or as the package's inlined data: URL, and both are answers to a question the extension currently does not have to ask.",
    },
    {
        key: "builtin-import/path", file: "src/utils/harperService.ts", verdict: DEGRADES, capability: "proofreading",
        why: "Joins __dirname to the wasm's filename, which is the same coupling as the line above and goes the same way.",
    },
    {
        key: "builtin-import/path", file: "src/webviewHtml.ts", verdict: DEGRADES, capability: "chrome",
        why: "Partners the os import above: it joins the home directory and tests isAbsolute for the custom CSS and JS setting. The join goes when homedir goes, and isAbsolute stops meaning anything once there is no local disk to be absolute on.",
    },
    {
        key: "builtin-import/path", file: "src/htmlExport.ts", verdict: SURVIVES, capability: "export",
        why: "Only basename, and already over target.path rather than target.fsPath at two of its three sites. Taking the segment after the last slash is the whole of what it does, so nothing here needs a host with a filesystem.",
    },
    {
        key: "builtin-import/path", file: "src/diskDrift.ts", verdict: SURVIVES, capability: "external-changes",
        why: "One call, basename, purely to name the file in a RelativePattern whose base is already a scheme-preserving Uri. uri.path.split(\"/\").pop() is the spelling the tree already uses elsewhere and it removes the import outright.",
    },
    {
        key: "builtin-import/path", file: "src/utils/imageService.ts", verdict: DEGRADES, capability: "images",
        why: "dirname and relative here compute the link text that is written into the user's markdown, so this is the one path site whose output is document bytes rather than an internal lookup. The math itself is posix string work; what it needs is a base that means something, which a non-file document does not give it.",
    },
    {
        key: "builtin-import/path", file: "src/utils/linkResolver.ts", verdict: DEGRADES, capability: "links",
        why: "The only module that reads path.sep, and a virtual path is slash-separated whatever the host OS is, so on a Windows desktop host the separator is right and on a Windows web host it would be wrong. It also leans on path.resolve discarding its base for an absolute argument, which Uri.joinPath does not do. path.posix preserves both exactly and is the lower-risk route.",
    },
    {
        key: "builtin-import/path", verdict: SURVIVES, capability: "cross-cutting",
        why: "At every other site path is basename, dirname, extname, join or relative over a string that is already a URI path, which is posix arithmetic with no host in it. The parts that do lose something are the isAbsolute branches and the Uri.file reconstitutions, which this audit raises separately as file-uri occurrences rather than hiding inside this rule.",
    },

    // ── Node globals ──────────────────────────────────────────────────────
    {
        key: "node-global/process.platform", verdict: DEGRADES, capability: "cross-cutting",
        why: "The modifier labels the webview prints, the shell quoting, and the feedback report's platform line all read it. A worker has no process; navigator.userAgentData is the nearest signal and it names the reader's browser rather than the machine the workspace is on, which for a remote workspace are two different answers.",
    },
    {
        key: "node-global/process.arch", verdict: DEGRADES, capability: "feedback",
        why: "One line of the feedback report's environment block. A worker cannot answer it, and the report is still worth sending with that line absent or approximate.",
    },
    {
        key: "node-global/process.pid", verdict: DROPS, capability: "agent-bridge",
        why: "Names the per-session attachment directory, which exists only so a locally running CLI can be handed a path. It goes with the child process it was for.",
    },
    {
        key: "node-global/Buffer", verdict: SURVIVES, capability: "cross-cutting",
        why: "Every use is a bytes-to-text or text-to-bytes conversion around vscode.workspace.fs, or a typed parameter on a child process's stdout. TextDecoder and TextEncoder do the conversions identically and the tree already spells it that way in htmlExport and whatsNew, so the right form is present and in the minority rather than absent.",
    },
    {
        key: "node-global/process.kill", verdict: DROPS, capability: "agent-bridge",
        why: "Signals a spawned harness's process group to cancel a run. It goes with the child process it is aimed at, and nothing in a worker has a process group to signal.",
    },
    {
        key: "node-global/__dirname", verdict: DEGRADES, capability: "proofreading",
        why: "The one site is the wasm path, and a worker has no module directory. context.extensionUri is the web answer and it yields a URI rather than a filesystem path, so the consumer changes as well as the producer.",
    },

    // ── URIs and schemes ──────────────────────────────────────────────────
    {
        key: "os-path/fsPath", file: "src/utils/imageService.ts", verdict: DEGRADES, capability: "images",
        why: "The sharpest fsPath site in the tree, because its output is document bytes: buildRelPath turns two fsPath strings into the relative link a saved image is written into the markdown as. Everywhere else a wrong fsPath costs a failed lookup; here it would cost a link in the user's file.",
    },
    {
        key: "os-path/fsPath", file: "src/agentBridge/publicApi.ts", verdict: DEGRADES, capability: "agent-bridge",
        why: "A field of the published BirtaApi contract rather than an internal read, so it cannot be quietly emptied or re-spelled. On a non-file document it still returns a string and that string names nothing a consumer can open, which is a promise the API is making and would not be keeping.",
    },
    {
        key: "os-path/fsPath", file: "src/diskDrift.ts", verdict: SURVIVES, capability: "external-changes",
        why: "The one read feeds path.basename purely to name a file in a watcher pattern, so what it wants is the last segment and not a filesystem path. Reading it off uri.path instead is exact and removes the coupling entirely.",
    },
    {
        key: "os-path/fsPath", verdict: DEGRADES, capability: "cross-cutting",
        why: "fsPath still returns a string for a non-file URI, so nothing throws and nothing reports a problem: it simply stops naming anything that can be opened. Several sites use it only as a map key, where uri.toString() is a strict improvement; the rest either move to uri.path or accept that on the web they name nothing. The scan cannot tell the two apart from one line, so it takes the coupling at the read.",
    },
    {
        key: "file-uri/Uri.file", file: "src/webviewHtml.ts", verdict: DEGRADES, capability: "chrome",
        why: "Rebuilds a file URI for the custom CSS and JS roots after taking a resolved URI down to an OS path. Uri.joinPath(uri, \"..\") is the scheme-preserving spelling for the parent, and the ~ and absolute forms have no web meaning and fall into the undefined the function already returns.",
    },
    {
        key: "file-uri/Uri.file", file: "src/suggestionProviders.ts", verdict: DEGRADES, capability: "links",
        why: "Reconstitutes a file URI from string path math to list a directory, and the catch beside it swallows the failure into an empty suggestion list. That is the silent shape: on a virtual workspace the completions simply stop appearing, with nothing logged and nothing to tell the reader the feature is off.",
    },
    {
        key: "file-uri/Uri.file", file: "src/agentBridge/askAgent.ts", verdict: DROPS, capability: "agent-bridge",
        why: "Wraps tmpdir() for the attachment staging directory, whose only purpose is to be a path a locally running CLI can open. It goes with the child process rather than needing a web substitute.",
    },
    {
        key: "file-uri/Uri.file", verdict: DEGRADES, capability: "images",
        why: "Builds a file-scheme URI from a string the code or the user's setting produced. On a workspace that is not on local disk no provider is registered for file:, so the read or write fails rather than landing somewhere wrong, which is the better of the two failures and still a feature that stops working.",
    },
    {
        key: "file-uri/pathToFileURL", verdict: DEGRADES, capability: "proofreading",
        why: "The wasm URL, raised here as well as at its import because the URL's scheme is the part harper.js branches on: a file: URL is what sends it down its own Node-only fs path.",
    },
    {
        key: "file-uri/file://", verdict: SURVIVES, capability: "chrome",
        why: "A literal file: prefix appearing in a string the code tests or builds for a local host, in a position where the web answer is to take the branch that already exists for a scheme that is not file:.",
    },
    /**
     * A scheme test's real verdict is decided by what its branch DOES, and a
     * scanner that reads one line at a time cannot see that. Both rules below
     * therefore take the coupling at the test and say so, the way the page
     * -ownership audit takes a listener's verdict at its registration rather
     * than from its handler body. The one site where the difference matters
     * most is not left to this family: `checkProviderGate` pins it by name.
     */
    {
        key: "file-scheme/eq", verdict: DEGRADES, capability: "cross-cutting",
        why: "A positive test for the local case. On the web it is simply false and the branch the code already has for a document that is not on disk is taken, so nothing breaks and a feature quietly goes off. The scan cannot read which feature, so the verdict is taken at the test.",
    },
    {
        key: "file-scheme/ne", verdict: DEGRADES, capability: "cross-cutting",
        why: "The same test the other way round. Most of these guard a fallback that a web host would always take, and one of them is the provider's own early return that renders a blank page. The scan cannot tell those apart from one line, so it takes the coupling at the test and the gate that matters is pinned separately by checkProviderGate.",
    },

    // ── fetch shapes a browser treats differently ─────────────────────────
    {
        key: "forbidden-header/user-agent", file: "src/utils/embedMetaFetcher.ts", verdict: DEGRADES, capability: "embeds",
        why: "user-agent is a forbidden header name in the Fetch standard: Node's fetch honours the setting and a browser's drops it. The oEmbed request would then identify itself as the host page, and a provider that varies its answer on it answers differently.",
    },
    {
        key: "forbidden-header/user-agent", file: "src/connectors/fetchCard.ts", verdict: DEGRADES, capability: "connectors",
        why: "Same forbidden header, on the one request that carries a credential. Dropping it changes nothing about the credential and changes what the provider sees the request as, which for an API that rate-limits or gates on a user agent is a behaviour change nothing would report.",
    },
    {
        key: "forbidden-header/user-agent", verdict: DEGRADES, capability: "unfurl",
        why: "user-agent is a forbidden header name in the Fetch standard, so a browser drops it where Node's fetch sends it. The comment beside this one says some hosts serve a leaner page or refuse without it, which makes the drop a change to what the unfurl reads back rather than a cosmetic one.",
    },
    {
        key: "manual-redirect/manual", file: "src/MarkdownEditorProvider.ts", verdict: DROPS, capability: "unfurl",
        why: "In Node a manual-redirect response carries a readable Location, which is the whole mechanism by which the unfurl loop re-runs the SSRF guard on every hop. In a browser it is an opaque filtered response with status 0 and no readable headers, so the loop falls straight through its own !res.ok branch and no redirect can be followed at all. Switching to redirect: follow would check only the first URL and let the browser visit hops nothing vetted, which is a weaker guard rather than the same one.",
    },
    {
        key: "manual-redirect/manual", verdict: SURVIVES, capability: "embeds",
        why: "These two sites never follow a redirect: any 3xx is a refusal, which is how the rule that a credential never crosses a redirect is kept. A browser's opaque filtered response has status 0 and fails the same !res.ok branch, so the outcome is identical and only the mechanism moves, from the code declining to follow to the browser declining to show.",
    },
];

/**
 * A coupling that is NOT in this tree, found in the built bundle instead.
 * Each entry names the module, the package that reaches for it, and why it is
 * not a defect. `--check` refuses any builtin in the bundle that neither the
 * source scan nor this list accounts for.
 */
export const DEPENDENCY_COUPLINGS = [
    {
        module: "fs",
        package: "harper.js",
        verdict: DEGRADES,
        capability: "proofreading",
        why: "harper.js reads its own wasm through a dynamic import(\"fs\") guarded by `typeof process !== \"undefined\" && binary.startsWith(\"file://\")`. Both arms of that guard are false in a worker, so the branch is dead there and the loader falls through to fetching the URL. The import is still statically present in the module, so a browser build has to stub or alias it rather than rely on the guard.",
    },
];

export function classify(occurrence) {
    const withFile = RULES.find((r) => r.key === `${occurrence.kind}/${occurrence.refinement}` && r.file === occurrence.file);
    if (withFile) return withFile;
    const general = RULES.find((r) => r.key === `${occurrence.kind}/${occurrence.refinement}` && !r.file);
    return general ?? null;
}

export function collect() {
    const { files, occurrences } = scan();
    return {
        files,
        occurrences: occurrences.map((o) => {
            const rule = classify(o);
            return rule
                ? { ...o, verdict: rule.verdict, capability: rule.capability, why: rule.why }
                : { ...o, verdict: "residue", capability: "residue", why: "" };
        }),
    };
}

// ─── Floors, so a scan that stopped reaching the tree cannot report clean ────

const FLOORS = {
    files: 60,
    /** Families known to exist. One that stops appearing means a pattern has rotted. */
    kinds: ["builtin-import", "node-global", "os-path", "file-uri", "file-scheme", "forbidden-header", "manual-redirect"],
    /** Modules known to be imported. A rule whose subject left the tree should be deleted, not left passing. */
    builtins: ["child_process", "crypto", "dns/promises", "fs", "net", "os", "path", "url"],
};

// ─── The dependency cross-check ──────────────────────────────────────────────

/**
 * Read the builtins the BUILT extension bundle actually requires, and hold each
 * one against what the source scan found. Exported and given its metafile as an
 * argument so a test can drive it with a synthetic one and never need a build.
 *
 * Returns { checked: false, note } when there is no metafile, because a check
 * that skips in silence is worth less than no check: the caller prints the note.
 */
export function crossCheckBundle(metafilePath, sourceModules) {
    if (!existsSync(metafilePath)) {
        return {
            checked: false,
            problems: [],
            note: `no metafile at ${relative(ROOT, metafilePath)}, so couplings inside dependencies were NOT checked — build with \`node esbuild.mjs --production --metafile\``,
        };
    }
    let meta;
    try {
        meta = JSON.parse(readFileSync(metafilePath, "utf8"));
    } catch (err) {
        return { checked: false, problems: [`metafile at ${relative(ROOT, metafilePath)} is unreadable: ${err.message}`], note: "" };
    }
    return crossCheckMeta(meta, sourceModules);
}

/**
 * The comparison itself, over a parsed metafile. Split out from the read so a
 * test can drive it with a metafile it wrote in memory: a guard that can only
 * be exercised by a real build is a guard that gets exercised by nobody.
 */
export function crossCheckMeta(meta, sourceModules, deps = DEPENDENCY_COUPLINGS) {
    const output = meta?.outputs?.["dist/extension.js"];
    if (!output) {
        return { checked: false, problems: ["metafile has no dist/extension.js output, so it is not a build of the extension bundle"], note: "" };
    }
    const bundled = new Set();
    for (const im of output.imports ?? []) {
        if (!im.external) continue;
        const name = String(im.path).replace(/^node:/, "");
        if (BUILTINS.includes(name)) bundled.add(name);
    }
    const accounted = new Set([...sourceModules, ...deps.map((d) => d.module)]);
    const problems = [];
    for (const name of [...bundled].sort()) {
        if (!accounted.has(name)) {
            problems.push(`the built bundle requires "${name}", which no source site and no DEPENDENCY_COUPLINGS entry accounts for — a dependency has grown a Node coupling`);
        }
    }
    // A dependency entry whose module has left the bundle should be deleted
    // rather than left claiming a coupling that is gone. This can only be asked
    // of a module the SOURCE does not also import: `fs` is both harper.js's
    // coupling and keybindings.ts's, so the bundle requiring it proves nothing
    // about harper.js. The limit is real and is recorded in the write-up's
    // residue rather than papered over with a check that cannot discriminate.
    for (const dep of deps) {
        if (sourceModules.has(dep.module)) continue;
        if (!bundled.has(dep.module)) {
            problems.push(`DEPENDENCY_COUPLINGS names "${dep.module}" for ${dep.package}, but the built bundle no longer requires it — delete the entry rather than leave it claiming a coupling that is gone`);
        }
    }
    return { checked: true, problems, note: "" };
}

/**
 * The audit's headline rests on one line of product code, and a line number
 * drifts out from under a document that is read a year later. So it is pinned
 * by its subject instead: the custom editor's own entry point refuses any
 * document whose scheme is not `file` and answers with an empty page, which on
 * a web host is every document there is. If that gate moves, narrows or goes,
 * this fails and says to re-read it rather than letting the write-up go on
 * asserting something the tree no longer does.
 *
 * Deliberately not a rule in the table above: the table is keyed by shape, and
 * every other `scheme !== "file"` in the tree is an ordinary fallback. What
 * makes this one different is what its branch does, which is the thing a
 * line-at-a-time scan cannot read.
 */
export function checkProviderGate(source) {
    const text = source ?? readFileSync(join(ROOT, "src", "MarkdownEditorProvider.ts"), "utf8");
    const entry = text.indexOf("async resolveCustomTextEditor(");
    if (entry === -1) {
        return ["resolveCustomTextEditor is no longer spelled that way in src/MarkdownEditorProvider.ts, so the gate this audit's headline rests on cannot be found"];
    }
    // The gate is the first thing the body does, so a short window is enough and
    // a long one would start catching unrelated scheme tests further down.
    const window = text.slice(entry, entry + 1200);
    const gated = /scheme\s*!==\s*["']file["']/.test(window);
    const blanks = /webview\.html\s*=\s*["'`]<!DOCTYPE html>/.test(window);
    if (!gated || !blanks) {
        return [
            "resolveCustomTextEditor no longer opens by refusing a non-file scheme with an empty page. That gate is the headline of docs/NODE_COUPLINGS.md: re-read it and update the write-up before clearing this.",
        ];
    }
    return [];
}

/**
 * The residue check is worth nothing unless the classifier can decline to
 * classify. Every occurrence in the tree has a rule today, so "residue is
 * empty" would otherwise be satisfied by a classifier that returned a verdict
 * for anything at all. These probes make it discriminate: two shapes that must
 * come back unclassified and one that must come back with a verdict.
 */
export function probeClassifier() {
    const problems = [];
    if (classify({ kind: "not-a-kind", refinement: "x", file: "src/x.ts" })) {
        problems.push("the classifier gave a verdict to an unknown kind, so residue cannot be trusted");
    }
    if (classify({ kind: "builtin-import", refinement: "worker_threads", file: "src/x.ts" })) {
        problems.push("the classifier gave a verdict to a builtin it has no rule for, so a new import would be sorted rather than raised");
    }
    if (!classify({ kind: "builtin-import", refinement: "net", file: "src/utils/urlGuard.ts" })) {
        problems.push("the classifier declined a shape it has a rule for, so the table is not being read");
    }
    return problems;
}

export function check(data, { metafile = METAFILE } = {}) {
    const problems = probeClassifier();
    problems.push(...checkProviderGate());

    if (data.files < FLOORS.files) {
        problems.push(`scanned ${data.files} TypeScript files, floor is ${FLOORS.files} — the scan is not reaching the tree`);
    }
    const kinds = new Set(data.occurrences.map((o) => o.kind));
    for (const k of FLOORS.kinds) {
        if (!kinds.has(k)) problems.push(`no occurrence of kind ${k} — a pattern that used to match has stopped matching`);
    }
    const modules = new Set(data.occurrences.filter((o) => o.kind === "builtin-import").map((o) => o.refinement));
    for (const b of FLOORS.builtins) {
        if (!modules.has(b)) problems.push(`no import of ${b} — either it left the tree, in which case delete its rule, or the import pattern has rotted`);
    }

    for (const o of data.occurrences) {
        if (o.verdict === "residue") {
            problems.push(`unclassified: ${o.file}:${o.line} ${o.kind}/${o.refinement} — ${o.text}`);
            continue;
        }
        if (!VERDICTS.includes(o.verdict)) problems.push(`bad verdict ${o.verdict} at ${o.file}:${o.line}`);
        if (!CAPABILITIES.includes(o.capability)) problems.push(`bad capability ${o.capability} at ${o.file}:${o.line}`);
        if (typeof o.why !== "string" || o.why.length < 80) problems.push(`rule for ${o.kind}/${o.refinement} carries no argument worth reading`);
    }

    const cross = crossCheckBundle(metafile, modules);
    problems.push(...cross.problems);
    return { problems, cross };
}

// ─── Report ──────────────────────────────────────────────────────────────────

function report(data, { byKind, byCapability, list }) {
    const withVerdict = data.occurrences.filter((o) => o.verdict !== "residue");
    const residue = data.occurrences.filter((o) => o.verdict === "residue");

    console.log(`Scanned ${data.files} product TypeScript files under ${SCAN_DIRS.join(", ")}.`);
    console.log(`${data.occurrences.length} couplings, ${withVerdict.length} with a verdict, ${residue.length} residue.\n`);

    console.log("By verdict:");
    for (const v of VERDICTS) {
        console.log(`  ${v.padEnd(9)} ${withVerdict.filter((o) => o.verdict === v).length}`);
    }
    console.log("");

    console.log("By capability, verdict worst-first:");
    for (const c of CAPABILITIES) {
        const items = withVerdict.filter((o) => o.capability === c);
        if (!items.length) continue;
        const worst = VERDICTS.slice().reverse().find((v) => items.some((o) => o.verdict === v));
        console.log(`  ${c.padEnd(18)} ${String(items.length).padStart(3)}  worst: ${worst}`);
    }
    console.log("");

    if (byKind || byCapability || list) {
        const groups = new Map();
        for (const o of withVerdict) {
            const key = list ? `${o.kind}/${o.refinement}` : byCapability ? o.capability : o.kind;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(o);
        }
        for (const [key, items] of [...groups.entries()].sort()) {
            console.log(`── ${key} (${items.length})`);
            for (const o of items) console.log(`   ${o.file}:${o.line}  [${o.verdict}] ${o.capability}  ${o.text}`);
            console.log("");
        }
    }

    if (residue.length) {
        console.log("Residue, by name:");
        for (const o of residue) console.log(`  ${o.file}:${o.line}  ${o.kind}/${o.refinement}  ${o.text}`);
        console.log("");
    }

    console.log("Couplings inside dependencies, which this scan cannot see:");
    for (const d of DEPENDENCY_COUPLINGS) console.log(`  ${d.module} <- ${d.package} [${d.verdict}] ${d.capability}`);
    const cross = crossCheckBundle(METAFILE, new Set(withVerdict.filter((o) => o.kind === "builtin-import").map((o) => o.refinement)));
    console.log(cross.checked ? "  (cross-checked against the built bundle)" : `  (${cross.note})`);
    console.log("");

    console.log("Not collected, and why:");
    for (const [what, why] of NOT_COLLECTED) console.log(`  ${what}: ${why}`);
}

// The CLI runs only when this file is the entry point, so a test can import
// `collect` and `check` without a scan and a report happening on import.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();

function main() {
    const argv = process.argv.slice(2);
    const data = collect();
    if (argv.includes("--json")) {
        console.log(JSON.stringify({ files: data.files, occurrences: data.occurrences, dependencyCouplings: DEPENDENCY_COUPLINGS }, null, 2));
        return;
    }
    if (argv.includes("--check")) {
        const { problems, cross } = check(data);
        if (problems.length) {
            console.error("audit-node-couplings --check failed:");
            for (const p of problems) console.error(`  ${p}`);
            process.exit(1);
        }
        console.log(`audit-node-couplings: ${data.occurrences.length} couplings, all with a verdict.`);
        if (!cross.checked) console.log(`note: ${cross.note}`);
        return;
    }
    report(data, {
        byKind: argv.includes("--by-kind"),
        byCapability: argv.includes("--by-capability"),
        list: argv.includes("--list"),
    });
}
