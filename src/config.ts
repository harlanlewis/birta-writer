/**
 * src/config.ts
 *
 * The ONE place the extension touches `vscode.workspace.getConfiguration`
 * ("birta"). Everything else reads settings through `readBirtaConfig` (a full
 * typed snapshot) or `readBirtaSetting` (a narrow single-key read for live
 * config-change handlers), with every default coming from the shared
 * `BIRTA_CONFIG_DEFAULTS` table — no inline `get(key, fallback)` literals.
 * Derived snapshot builders (proofread/toolbar/fonts/content width) and the
 * resource-scoped native `editor.*` reads the webview bootstrap needs live
 * here too, so the config surface reads in one file.
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
import type { ProofreadConfig, ProofreadOptionKey, ToolbarConfig, FontPreset, FontStacks } from "../shared/messages";
import { resolveFontStacks, clampFontSizePercent } from "../shared/fontPresets";
import {
    resolveContentWidth,
    normalizeContentWidthMode,
    type ContentWidthMode,
    type ContentWidthResolution,
} from "../shared/contentWidth";
import {
    normalizeFoldingControlsMode,
    DEFAULT_FOLDING_CONTROLS_MODE,
    type FoldingControlsMode,
} from "../shared/foldingControls";

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

// ── Derived config snapshots ────────────────────────────────────────────────
// Shapes the webview consumes (bootstrap injection + live update messages),
// built from the snapshot above. Free functions so the HTML builder can use
// them without importing the provider.

/** Snapshot of the proofread (style check + spell check) settings. */
export function getProofreadConfig(config: BirtaConfig = readBirtaConfig()): ProofreadConfig {
    const {
        proofreadingEnabled, styleCheck, fillers, redundancies, cliches,
        wordiness, aiVocabulary, aiArtifacts, passive, negativeParallelism,
        longSentences, ruleOfThree, emDash, nonAsciiPunct, styleExceptions,
        spellCheck, grammarCheck, userWords,
    } = config;
    return {
        proofreadingEnabled, styleCheck, fillers, redundancies, cliches,
        wordiness, aiVocabulary, aiArtifacts, passive, negativeParallelism,
        longSentences, ruleOfThree, emDash, nonAsciiPunct, styleExceptions,
        spellCheck, grammarCheck, userWords,
    };
}

/**
 * Snapshot of the per-item toolbar placement settings. VS Code merges the
 * contributed defaults into the nested `toolbar.items` read, so every
 * registered item id is present with its effective value.
 */
export function getToolbarConfig(config: BirtaConfig = readBirtaConfig()): ToolbarConfig {
    return {
        placements: config.toolbarPlacements,
        order: config.toolbarOrder,
        visible: config.toolbarVisible,
    };
}

/** Floating selection toolbar: master on/off + per-item visibility (merged read). */
export function getFloatingToolbarConfig(
    config: BirtaConfig = readBirtaConfig(),
): { enabled: boolean; items: Record<string, boolean> } {
    return {
        enabled: config.floatingToolbarEnabled,
        items: config.floatingToolbarItems,
    };
}

/** The effective per-preset font stacks (user overrides over the built-ins). */
export function getFontStacks(config: BirtaConfig = readBirtaConfig()): FontStacks {
    return resolveFontStacks({
        sans: config.fontFamilySans,
        serif: config.fontFamilySerif,
        mono: config.fontFamilyMono,
    });
}

/**
 * Resolve the effective content width from the `contentWidth` mode (full /
 * fixed) and the `maxContentWidth` ch setting. Shared by the initial HTML
 * injection and the live `onDidChangeConfiguration` broadcast.
 */
export function resolveContentWidthConfig(): ContentWidthResolution {
    return resolveContentWidth(
        normalizeContentWidthMode(readBirtaSetting("contentWidth")),
        readBirtaSetting("maxContentWidth"),
    );
}

/**
 * The fold-affordance config for one document, derived from the user's own
 * editor settings (no `birta.*` knob — MAR-110). Read scoped to the document
 * URI: `editor.*` is resource- and language-scoped (`[markdown]` overrides,
 * multi-root workspaces), the codeBlockWordWrap pattern.
 */
export function readFoldingConfig(
    documentUri: vscode.Uri,
): { controls: FoldingControlsMode; enabled: boolean } {
    const editorCfg = vscode.workspace.getConfiguration("editor", documentUri);
    return {
        controls: normalizeFoldingControlsMode(
            editorCfg.get<string>("showFoldingControls", DEFAULT_FOLDING_CONTROLS_MODE),
        ),
        enabled: editorCfg.get<boolean>("folding", true) !== false,
    };
}

// ─── Settings write-back (webview/toolbar → settings) ───────────────────────
// The write half of the config seam, next to the read half so the extension's
// entire `birta.*` surface lives in this one file (moved off the provider,
// where these sat as unrelated statics — 2026-07-17 round-2 critique).

/**
 * Persist a setting, writing to the scope that currently wins — a Global
 * write would be silently overridden by an existing workspace value.
 */
export function updateSettingRespectingScope(key: string, value: unknown): void {
    const cfg = getBirtaConfiguration();
    const target = cfg.inspect(key)?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    void cfg.update(key, value, target);
}

/**
 * Every proofread toggle the webview may write, mapped to its setting path.
 * `proofreading` is the master gate; the three domain masters and the
 * sub-checks live under their own keys. Unknown keys are ignored (guards
 * the write).
 */
const PROOFREAD_SETTING: Record<ProofreadOptionKey, string> = {
    proofreading: "proofreading.enabled",
    styleCheck: "styleCheck.enabled",
    spellCheck: "spellCheck.enabled",
    grammarCheck: "grammarCheck.enabled",
    fillers: "styleCheck.fillers",
    redundancies: "styleCheck.redundancies",
    cliches: "styleCheck.cliches",
    wordiness: "styleCheck.wordiness",
    aiVocabulary: "styleCheck.aiVocabulary",
    aiArtifacts: "styleCheck.aiArtifacts",
    passive: "styleCheck.passive",
    longSentences: "styleCheck.longSentences",
    negativeParallelism: "styleCheck.negativeParallelism",
    ruleOfThree: "styleCheck.ruleOfThree",
    emDash: "styleCheck.emDash",
    nonAsciiPunct: "styleCheck.nonAsciiPunct",
};

/** Persist one proofread toggle (checks menu → settings write-back). */
export function setProofreadOption(key: ProofreadOptionKey, value: boolean): void {
    const path = PROOFREAD_SETTING[key];
    if (!path) { return; }
    updateSettingRespectingScope(path, value);
}

/**
 * Flip the master proofreading gate (command palette / keyboard shortcut).
 * This gates the whole feature on/off without touching the per-domain
 * switches, so turning it back on restores exactly what was enabled before.
 */
export function toggleProofreading(): void {
    updateSettingRespectingScope(
        "proofreading.enabled",
        !readBirtaSetting("proofreadingEnabled"),
    );
}

/**
 * Add a word to the personal spelling dictionary. Always writes to the
 * user's GLOBAL settings, never the workspace: "Add to dictionary" is a
 * personal, single-click choice, and a workspace write lands in the
 * project's tracked `.vscode/settings.json` — silently committing the
 * dictionary to git and sharing it with everyone. A personal word list
 * applies across projects anyway (a name like "Birta" isn't project jargon;
 * genuinely shared jargon is a deliberate edit of the workspace setting).
 */
export function addUserWord(word: string): void {
    const trimmed = word?.trim();
    if (!trimmed) { return; }
    const words = readBirtaSetting("userWords");
    if (words.includes(trimmed)) { return; }
    void getBirtaConfiguration().update(
        "spellCheck.userWords",
        [...words, trimmed],
        vscode.ConfigurationTarget.Global,
    );
}

/** Persist the font-picker choice (toolbar → settings write-back). */
export function setFontPreset(preset: FontPreset): void {
    updateSettingRespectingScope("fontPreset", preset);
}

/** Persist the font-size stepper choice (toolbar → settings write-back). */
export function setFontSize(size: number): void {
    updateSettingRespectingScope("fontSize", clampFontSizePercent(size));
}

/** Persist the content-width mode (toolbar → settings write-back). */
export function setContentWidth(mode: ContentWidthMode): void {
    updateSettingRespectingScope("contentWidth", normalizeContentWidthMode(mode));
}
