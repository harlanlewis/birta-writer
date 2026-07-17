/**
 * src/config.ts
 *
 * The ONE place the extension touches `vscode.workspace.getConfiguration`
 * ("birta"). Everything else reads settings through `readBirtaConfig` (a full
 * typed snapshot) or `readBirtaSetting` (a narrow single-key read for live
 * config-change handlers), with every default coming from the shared
 * `BIRTA_CONFIG_DEFAULTS` table — no inline `get(key, fallback)` literals.
 *
 * Reads are never cached: VS Code's WorkspaceConfiguration is itself a cheap
 * snapshot, and re-reading per call is what keeps `onDidChangeConfiguration`
 * handlers (and tests that swap the mock) seeing the current values.
 */
import * as vscode from "vscode";
import {
    BIRTA_CONFIG_DEFAULTS,
    BIRTA_SETTING_KEYS,
    type BirtaConfig,
} from "../shared/config";

export type { BirtaConfig };

/**
 * The raw `birta` configuration section. Reach for this ONLY when the
 * WorkspaceConfiguration object itself is needed (writes via `update`, scope
 * inspection via `inspect`, or APIs that take the section, e.g.
 * saveImageLocally); plain reads go through readBirtaConfig/readBirtaSetting.
 */
export function getBirtaConfiguration(scope?: vscode.Uri): vscode.WorkspaceConfiguration {
    return scope
        ? vscode.workspace.getConfiguration("birta", scope)
        : vscode.workspace.getConfiguration("birta");
}

/** One setting, typed, with its default from the shared table. */
export function readBirtaSetting<K extends keyof BirtaConfig>(
    key: K,
    scope?: vscode.Uri,
): BirtaConfig[K] {
    return getBirtaConfiguration(scope).get(
        BIRTA_SETTING_KEYS[key],
        BIRTA_CONFIG_DEFAULTS[key],
    ) as BirtaConfig[K];
}

/** A full typed snapshot of the `birta.*` settings (fresh read, never cached). */
export function readBirtaConfig(scope?: vscode.Uri): BirtaConfig {
    const cfg = getBirtaConfiguration(scope);
    const out: Record<string, unknown> = {};
    for (const field of Object.keys(BIRTA_SETTING_KEYS) as Array<keyof BirtaConfig>) {
        out[field] = cfg.get(BIRTA_SETTING_KEYS[field], BIRTA_CONFIG_DEFAULTS[field]);
    }
    return out as unknown as BirtaConfig;
}
