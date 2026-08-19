/**
 * Running the capability probe, and remembering the answer.
 *
 * `harnessCapabilities.ts` reads help text; this spawns the harness to get
 * it. Split because the parse is the part worth testing exhaustively and
 * spawning is the part that must not happen during a test.
 *
 * Timing and caching are the whole design here, because the panel has to
 * feel instant, and a process spawn never can be. So:
 *
 *   - the answer is cached in `globalState`, keyed by the harness name and
 *     the version it reported, so it survives reloads and machines;
 *   - the version check runs first and is the only cost when nothing has
 *     changed, so a warm probe is one spawn rather than two;
 *   - the probe is kicked off when a document opens, not when the panel is
 *     opened, so by the time anyone types `/ai` the answer is already in
 *     memory. Nothing waits on it: a panel opened before the probe lands
 *     shows no pickers and gains them when it resolves.
 *
 * A probe that fails in any way (no such binary, a non-zero exit, a timeout)
 * caches nothing and reports no capabilities. The panel then offers no model
 * or effort control and the user's template runs exactly as it does today,
 * which is the same graceful floor a harness whose help documents neither
 * flag lands on.
 */
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { harnessName, parseHarnessHelp, type HarnessCapabilities } from "./harnessCapabilities";

import { reportError } from "../errorSink";

/** Where a probe result lives between sessions. */
const CACHE_PREFIX = "birta.harnessCaps:";
/** A harness that does not answer this fast is not one we make anyone wait for. */
const PROBE_TIMEOUT_MS = 4000;
/** Help text beyond this is not help text; refuse rather than parse megabytes. */
const MAX_HELP_BYTES = 512 * 1024;

/** In-memory answer for this session, so repeated opens cost nothing at all. */
const live = new Map<string, HarnessCapabilities>();
/** In-flight probes, so ten documents opening at once spawn one process. */
const inFlight = new Map<string, Promise<HarnessCapabilities | undefined>>();

/** Run `binary args...`, resolving to stdout, or undefined for any failure. */
function run(binary: string, args: string[]): Promise<string | undefined> {
    return new Promise((resolve) => {
        execFile(
            binary,
            args,
            { timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_HELP_BYTES, windowsHide: true },
            (err, stdout) => resolve(err ? undefined : stdout),
        );
    });
}

/** The capabilities already known for `template`'s harness, if any. */
export function cachedCapabilities(template: string): HarnessCapabilities | undefined {
    return live.get(harnessName(template));
}

/**
 * Learn what the template's harness accepts, from cache when the version is
 * unchanged. Resolves undefined when the harness cannot be probed at all.
 *
 * Only the FIRST word of the template is ever executed, with `--version` and
 * `--help` as its only arguments and no shell: the template is a shell
 * string the user configured, and running it here (rather than composing a
 * request) would execute their agent for no reason. `execFile` with an
 * argument array is what keeps the rest of the template inert.
 */
export async function probeHarness(
    context: vscode.ExtensionContext,
    template: string,
): Promise<HarnessCapabilities | undefined> {
    const binary = harnessName(template);
    if (!binary || binary === "agent") { return undefined; }
    const existing = inFlight.get(binary);
    if (existing) { return existing; }

    const probe = (async (): Promise<HarnessCapabilities | undefined> => {
        try {
            const version = (await run(binary, ["--version"]))?.trim();
            if (version === undefined) { return undefined; }
            const key = `${CACHE_PREFIX}${binary}@${version}`;
            const cached = context.globalState.get<HarnessCapabilities>(key);
            if (cached) {
                live.set(binary, cached);
                return cached;
            }
            const help = await run(binary, ["--help"]);
            if (help === undefined) { return undefined; }
            const caps = parseHarnessHelp(binary, version, help);
            live.set(binary, caps);
            await context.globalState.update(key, caps);
            return caps;
        } catch (err) {
            reportError("probeHarness", err);
            return undefined;
        } finally {
            inFlight.delete(binary);
        }
    })();
    inFlight.set(binary, probe);
    return probe;
}

/** Drop every remembered answer. Tests only; the cache is otherwise permanent. */
export function _resetHarnessProbeCache(): void {
    live.clear();
    inFlight.clear();
}
