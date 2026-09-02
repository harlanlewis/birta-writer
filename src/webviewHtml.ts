/**
 * webviewHtml.ts
 *
 * The webview's HTML/CSP bootstrap, extracted from the provider (MAR-168):
 * nonce-based CSP, the settings snapshot injected as `window.__i18n`, the CSS
 * variable seed values, and resolution of user custom CSS/JS resources.
 * Config values come from src/config.ts; no document/sync state lives here.
 */
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import { getNonce } from "./utils/getNonce";
import { EMBED_CSP_FRAME_HOSTS, EMBED_CSP_IMG_HOSTS } from "../shared/embedProviders";
import {
    readBirtaConfig,
    readFoldingConfig,
    getFontStacks,
    getProofreadConfig,
    getToolbarConfig,
    getFloatingToolbarConfig,
    resolveContentWidthConfig,
    type BirtaConfig,
} from "./config";
import { BIRTA_CONFIG_DEFAULTS, normalizeCopyFormat, normalizePasteFormat } from "../shared/config";
import { resolveFontFamily, clampFontSizePercent } from "../shared/fontPresets";
import { clampMaxWidthCh } from "../shared/contentWidth";
import { normalizeBlockHandlesMode, blockHandlesBodyClass } from "../shared/blockHandles";
import { normalizeMermaidThemeMode } from "../shared/mermaid";
import { normalizePlantUmlThemeMode } from "../shared/plantuml";
import { normalizeSyntaxSets } from "../shared/syntaxSets";
import { normalizeTocVisibility } from "../shared/tocVisibility";
import { foldingBodyClasses } from "../shared/foldingControls";
import { HOST_PROFILES } from "../shared/hostProfile";
import { hostShortcutsFor } from "./keybindings";

/**
 * Escape a string for interpolation into a double-quoted HTML attribute value.
 * Required for the content font stack: the built-in serif/sans/mono presets
 * (and user `fontFamily*` overrides) contain `"…"` around multi-word family
 * names, which would otherwise close the `style="…"` attribute and scatter the
 * family names as bogus attributes.
 */
export function escapeHtmlAttr(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/** Clamp a numeric setting to [min, max], falling back when non-finite. */
export function clampNumberSetting(
    value: number | undefined,
    fallback: number,
    min: number,
    max: number,
): number {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(value as number)));
}

/** clampNumberSetting rendered as a CSS px value. */
function pixelSettingCssValue(
    value: number | undefined,
    fallback: number,
    min: number,
    max: number,
): string {
    return `${clampNumberSetting(value, fallback, min, max)}px`;
}

/** Effective code-block word wrap: the setting, or the editor's own wordWrap when inherited. */
function resolveCodeBlockWordWrap(
    documentUri: vscode.Uri,
    value: BirtaConfig["codeBlockWordWrap"],
): boolean {
    if (value === "on") {
        return true;
    }
    if (value === "off") {
        return false;
    }

    const editorWordWrap = vscode.workspace
        .getConfiguration("editor", documentUri)
        .get<string>("wordWrap", "off");
    return editorWordWrap !== "off";
}

/**
 * Directories containing the user's custom CSS/JS resources, for
 * localResourceRoots (so the webview may load them).
 */
export function getCustomResourceRoots(documentUri: vscode.Uri): vscode.Uri[] {
    const config = readBirtaConfig();
    const paths = [...config.customCss, ...config.customJs];
    const roots: vscode.Uri[] = [];
    const seen = new Set<string>();
    for (const resourcePath of paths) {
        const uri = resolveCustomResourceUri(resourcePath, documentUri);
        if (!uri) { continue; }
        const root = vscode.Uri.file(path.dirname(uri.fsPath));
        const key = root.toString();
        if (!seen.has(key)) {
            seen.add(key);
            roots.push(root);
        }
    }
    return roots;
}

function getCustomResourceUris(
    webview: vscode.Webview,
    documentUri: vscode.Uri,
    resourcePaths: string[] | undefined,
): string[] {
    return (resourcePaths ?? [])
        .map(resourcePath => resolveCustomResourceUri(resourcePath, documentUri))
        .filter((uri): uri is vscode.Uri => Boolean(uri))
        .map(uri => webview.asWebviewUri(uri).toString());
}

function resolveCustomResourceUri(resourcePath: string, documentUri: vscode.Uri): vscode.Uri | undefined {
    const trimmed = resourcePath.trim();
    if (!trimmed) { return undefined; }

    const workspaceRoot = vscode.workspace.getWorkspaceFolder(documentUri)?.uri.fsPath
        ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let resolved = workspaceRoot
        ? trimmed
            .replace(/\$\{workspaceFolder\}/g, workspaceRoot)
            .replace(/\$\{workspaceRoot\}/g, workspaceRoot)
        : trimmed;
    if (resolved.startsWith("~/")) {
        resolved = path.join(os.homedir(), resolved.slice(2));
    } else if (resolved === "~") {
        resolved = os.homedir();
    } else if (!path.isAbsolute(resolved)) {
        const baseDir = workspaceRoot
            ?? (documentUri.scheme === "file" ? path.dirname(documentUri.fsPath) : undefined);
        if (!baseDir) { return undefined; }
        resolved = path.join(baseDir, resolved);
    }

    return vscode.Uri.file(resolved);
}

/**
 * The webview URIs a relative resource URL in RENDERED HTML resolves against.
 *
 * A Markdown image's `src` is rewritten to a webview URI before the content
 * reaches the webview, but raw HTML reaches the file verbatim and is rendered
 * from its own bytes, so an `<img src="images/cat.png">` inside an html block
 * has nothing to resolve against and loads from the webview's own origin.
 * Rewriting those bytes too would put a session-scoped URI in front of the user
 * in the source panel, so the resolution happens at render instead
 * (webview/utils/resourceUri.ts) and these are what it needs.
 *
 * Both end in `/`, because a base without one drops its last segment. Empty for
 * a document that has no directory (untitled, or a non-`file` scheme), which
 * leaves resolution off and every URL as authored.
 */
export function getResourceBaseUris(
    webview: vscode.Webview,
    documentUri: vscode.Uri,
): { resourceBaseUri: string; workspaceBaseUri: string } {
    if (documentUri.scheme !== "file") {
        return { resourceBaseUri: "", workspaceBaseUri: "" };
    }
    const asDirectory = (uri: vscode.Uri): string => {
        const webviewUri = webview.asWebviewUri(uri);
        return webviewUri
            .with({ path: webviewUri.path.endsWith("/") ? webviewUri.path : `${webviewUri.path}/` })
            .toString();
    };
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(documentUri)?.uri;
    return {
        resourceBaseUri: asDirectory(vscode.Uri.joinPath(documentUri, "..")),
        // The `@/` alias is the workspace root, and falls back to the document's
        // own directory exactly as the Markdown image rewrite does.
        workspaceBaseUri: asDirectory(workspaceRoot ?? vscode.Uri.joinPath(documentUri, "..")),
    };
}

/** The full document HTML for one editor webview. */
export function buildWebviewHtml(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    context: vscode.ExtensionContext,
): string {
    const config = readBirtaConfig();
    const maxHeight = config.codeBlockMaxHeight;
    const contentWidth = resolveContentWidthConfig();
    const maxWidthCssValue = contentWidth.cssValue;
    const tocContentGap = pixelSettingCssValue(config.tocContentGap, BIRTA_CONFIG_DEFAULTS.tocContentGap, 16, 240);
    // User-dragged TOC panel width (birta.tocWidth), injected as a CSS var.
    const tocWidth = clampNumberSetting(config.tocWidth, 220, 150, 600);
    // ToC show/hide preference (birta.tocVisibility): "auto" defers to the
    // heading-count heuristic, "shown"/"hidden" force it. Normalized so a
    // settings.json typo can't reach the webview. Injected into __i18n.
    const tocVisibility = normalizeTocVisibility(config.tocVisibility);
    const tocRight = config.tocPosition === "right";
    const isAutoWidth = contentWidth.isAuto;
    const fontPreset = config.fontPreset;
    const fontStacks = getFontStacks(config);
    // `null` for the "editor" preset (inherit the VS Code editor font). When
    // set, this is injected as an INLINE style on <html> below — not into the
    // <style> block — so that switching to the "editor" preset at runtime,
    // which does `documentElement.style.removeProperty("--content-font-family")`
    // (see webview/messageHandlers.ts), actually clears it. removeProperty only
    // touches inline styles; a value baked into a <style> rule would survive and
    // leave the content stuck on the old font. The stack must be attribute-
    // escaped (it contains `"…"` around family names): see escapeHtmlAttr.
    const resolvedFont = resolveFontFamily(fontPreset, fontStacks);
    const contentFontStyleAttr = resolvedFont
        ? ` style="--content-font-family: ${escapeHtmlAttr(resolvedFont)}"`
        : "";
    const fontSize = clampFontSizePercent(config.fontSize);
    const maxContentWidth = clampMaxWidthCh(config.maxContentWidth);
    const customCssUris = getCustomResourceUris(webview, document.uri, config.customCss);
    const customJsUris = getCustomResourceUris(webview, document.uri, config.customJs);
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(
            context.extensionUri,
            "dist",
            "webview.js",
        ),
    );
    const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(
            context.extensionUri,
            "dist",
            "webview.css",
        ),
    );
    const nonce = getNonce();

    const isMac = process.platform === 'darwin';
    // English is the sole source language: t() falls back to the key itself,
    // so the webview renders the English base strings with no translation map.
    const translations: Record<string, string> = {};
    const debugMode = config.debugMode;
    const codeBlockAutoConvert = config.codeBlockAutoConvert;
    const smartLinks = config.smartLinks;
    // Master network switch (MAR-179): offline by default. Baked into __i18n so
    // the webview can gate every network feature on `network && <feature>` and
    // the just-in-time opt-in can read it synchronously.
    const networkEnabled = config.networkEnabled;
    const pasteUnfurl = config.pasteUnfurlEnabled;
    const pasteUnfurlAutoApply = config.pasteUnfurlAutoApply;
    const linkCardsEnabled = config.linkCardsEnabled;
    // Baked in rather than pushed after mount (MAR-53): the read-only lock is a
    // predicate the very first view update reads, so a value arriving by
    // message would paint one frame — and admit one keystroke — editable.
    const readOnly = config.readOnly;
    const calcEnabled = config.calcEnabled;
    const calcBlocksEnabled = config.calcBlocksEnabled;
    const calcAutoInsert = config.calcAutoInsert;
    const autoUpdateAnchors = config.autoUpdateAnchors;
    const embedsEnabled = config.embedsEnabled;
    const embedProviders = config.embedProviders;
    // URL embeds (MAR-56/MAR-186) need two extra CSP grants: the thumbnail
    // image hosts (img-src — YouTube is the only thumbnail provider) and the
    // provider player iframe hosts (frame-src, since default-src 'none'
    // otherwise blocks all iframes). Derived from the shared provider table
    // (shared/embedProviders.ts) — exact hosts, no wildcards, one source both
    // sides read; a provider without a player (GitHub's info card) adds
    // nothing there.
    //
    // Emitted UNCONDITIONALLY, even though embeds may be gated off. CSP is fixed
    // at panel load and cannot change without recreating the webview, so gating
    // these grants meant that enabling embeds in a running editor produced a
    // card with a broken thumbnail — the grant was missing no matter what the
    // plugin did (MAR-183). A grant PERMITS a request; it never makes one. With
    // embeds off, no card is built, no thumbnail element exists, and nothing is
    // fetched: the offline-by-default guarantee lives in the gated code paths,
    // not in the absence of a CSP entry.
    const embedImgHosts = ` ${EMBED_CSP_IMG_HOSTS.join(" ")}`;
    const embedFrameSrc = `\n             frame-src ${EMBED_CSP_FRAME_HOSTS.join(" ")};`;
    const checklistSinkChecked = config.checklistSinkChecked;
    const codeBlockWordWrap = resolveCodeBlockWordWrap(document.uri, config.codeBlockWordWrap);
    const tocAutoHideThreshold = clampNumberSetting(config.tocAutoHideThreshold, BIRTA_CONFIG_DEFAULTS.tocAutoHideThreshold, 0, 20);
    const frontmatterExpanded = config.frontmatterExpanded;
    // Default OFF. readBirtaConfig always fills this from BIRTA_CONFIG_DEFAULTS,
    // so `=== true` and the previous `!== false` behave identically today; the
    // point is that the surviving shape states the CURRENT default's polarity,
    // the way `lineNumbers` below does, rather than the one it replaced.
    const frontmatterAddButton = config.frontmatterAddButton === true;
    const copyFormat = normalizeCopyFormat(config.copyFormat);
    const pasteFormat = normalizePasteFormat(config.pasteFormat);
    const blockHandles = normalizeBlockHandlesMode(config.blockHandles);
    // Default OFF, and the webview treats anything but `true` as off: the
    // gutter's module is never even fetched unless this is on.
    const lineNumbers = config.lineNumbers === true;
    const mermaidTheme = normalizeMermaidThemeMode(config.mermaidTheme);
    const plantumlTheme = normalizePlantUmlThemeMode(config.plantumlTheme);
    // Which targets' syntax the editor OFFERS to write. Normalized here
    // rather than in the page: a settings.json typo would otherwise reach the
    // gate as a set nothing provides, and the page reads this blob on every
    // call precisely so it has no second chance to normalize it.
    const syntaxSets = normalizeSyntaxSets(config.syntaxSets);
    const folding = readFoldingConfig(document.uri);
    const proofread = getProofreadConfig(config);
    const toolbar = getToolbarConfig(config);
    const floatingToolbar = getFloatingToolbarConfig(config);
    const documentUri = document.uri.toString();
    const { resourceBaseUri, workspaceBaseUri } = getResourceBaseUris(webview, document.uri);
    // .replace(/</g, "\\u003c"): JSON.stringify leaves "<" intact, so a string
    // setting containing "</script>" would close the inline script element
    // early (no code execution under the nonce CSP, but style injection).
    const i18nScript = `window.__i18n=${JSON.stringify({ translations, isMac, readOnly, debugMode, codeBlockAutoConvert, smartLinks, network: networkEnabled, pasteUnfurl, pasteUnfurlAutoApply, linkCardsEnabled, calcEnabled, calcBlocksEnabled, calcAutoInsert, autoUpdateAnchors, embedsEnabled, embedProviders, checklistSinkChecked, lineNumbers, notesCustomMarkers: config.notesCustomMarkers, notesHighlightMarkers: config.notesHighlightMarkers, reviewGroupByType: config.reviewGroupByType, codeBlockWordWrap, tocAutoHideThreshold, tocVisibility, frontmatterExpanded, frontmatterAddButton, copyFormat, pasteFormat, proofread, toolbar, floatingToolbar, fontPreset, fontStacks, fontSize, contentWidth: contentWidth.mode, maxContentWidth, mermaidTheme, plantumlTheme, syntaxSets, documentUri, resourceBaseUri, workspaceBaseUri, host: { capabilities: HOST_PROFILES.vscode, arrangements: [], shortcuts: hostShortcutsFor(context, process.platform) } }).replace(/</g, "\\u003c")};`;
    const bodyClasses = [
        isAutoWidth ? "editor-width-auto" : "",
        codeBlockWordWrap ? "code-block-word-wrap" : "",
        tocRight ? "toc-right" : "",
        blockHandlesBodyClass(blockHandles) ?? "",
        ...foldingBodyClasses(folding.controls, folding.enabled),
    ].filter(Boolean).join(" ");

    // `'wasm-unsafe-eval'` in script-src is what lets the PlantUML engine
    // (a WebAssembly build, see webview/utils/plantUmlLoader.ts) compile. Blink
    // refuses `WebAssembly.instantiate` without it, verified both ways in
    // headless Chromium against this exact policy.
    //
    // It is narrower than it looks, and deliberately not `'unsafe-eval'`: it
    // permits WebAssembly compilation and NOTHING else. `eval`, `new Function`,
    // and string-to-code in JavaScript all stay blocked, and it adds no script
    // source — running a wasm module still requires script that the nonce
    // already had to admit. It also grants no network reach: `default-src
    // 'none'` still applies to `connect-src`, so the webview cannot fetch, and
    // the engine is inlined into its own lazy chunk rather than being fetched
    // from disk precisely so this stays true.
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}"${contentFontStyleAttr}>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval';
             worker-src blob:;
             img-src ${webview.cspSource} data:${embedImgHosts};${embedFrameSrc}
             font-src ${webview.cspSource} data:;">
	  <meta name="viewport" content="width=device-width, initial-scale=1.0">
	  <title>Markdown Editor</title>
	  <link rel="stylesheet" href="${styleUri}">
  ${customCssUris.map(uri => `<link rel="stylesheet" href="${uri}">`).join("\n  ")}
	  <style>:root { --code-block-max-height: ${maxHeight}px; --editor-max-width: ${maxWidthCssValue}; --toc-width: ${tocWidth}px; --toc-tab-width: 20px; --toc-content-gap: ${tocContentGap}; --content-font-scale: ${fontSize / 100}; }</style>
	</head>
	<body class="${bodyClasses}">
	  <div class="editor-topbar"></div>
	  <div id="editor"></div>
	  <script nonce="${nonce}">${i18nScript}</script>
	  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
	  ${customJsUris.map(uri => `<script type="module" nonce="${nonce}" src="${uri}"></script>`).join("\n  ")}
	</body>
	</html>`;
}
