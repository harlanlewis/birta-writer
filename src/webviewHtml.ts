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
import { BIRTA_CONFIG_DEFAULTS } from "../shared/config";
import { resolveFontFamily, clampFontSizePercent } from "../shared/fontPresets";
import { clampMaxWidthCh } from "../shared/contentWidth";
import { normalizeBlockHandlesMode, blockHandlesBodyClass } from "../shared/blockHandles";
import { normalizeMermaidThemeMode } from "../shared/mermaid";
import { foldingBodyClasses } from "../shared/foldingControls";

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
    // User-dragged TOC panel width, persisted across documents and sessions
    const tocWidth = clampNumberSetting(context.globalState.get<number>("tocWidth"), 220, 150, 600);
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
    const pasteUnfurl = config.pasteUnfurlEnabled;
    const calcEnabled = config.calcEnabled;
    const calcAutoInsert = config.calcAutoInsert;
    const embedsEnabled = config.embedsEnabled;
    // URL embeds (MAR-56) need two extra CSP grants: the YouTube thumbnail image
    // hosts (img-src) and the privacy-mode player iframe host (a new frame-src,
    // since default-src 'none' otherwise blocks all iframes). Added ADDITIVELY
    // and ONLY when embeds are enabled — specific hosts, no wildcards. When OFF,
    // the emitted CSP is byte-identical to before this feature existed.
    const embedImgHosts = embedsEnabled ? " https://i.ytimg.com https://img.youtube.com" : "";
    const embedFrameSrc = embedsEnabled ? "\n             frame-src https://www.youtube-nocookie.com;" : "";
    const checklistSinkChecked = config.checklistSinkChecked;
    const codeBlockWordWrap = resolveCodeBlockWordWrap(document.uri, config.codeBlockWordWrap);
    const tocAutoHideThreshold = clampNumberSetting(config.tocAutoHideThreshold, BIRTA_CONFIG_DEFAULTS.tocAutoHideThreshold, 0, 20);
    const frontmatterExpanded = config.frontmatterExpanded;
    const blockHandles = normalizeBlockHandlesMode(config.blockHandles);
    const mermaidTheme = normalizeMermaidThemeMode(config.mermaidTheme);
    const folding = readFoldingConfig(document.uri);
    const proofread = getProofreadConfig(config);
    const toolbar = getToolbarConfig(config);
    const floatingToolbar = getFloatingToolbarConfig(config);
    const documentUri = document.uri.toString();
    // The extension's display name, the single source for any UI that must
    // name the product (e.g. "Open <name> settings"). From package.json;
    // optional-chained so a stripped-down test context still resolves.
    const productName =
        (context.extension?.packageJSON?.displayName as string | undefined) ?? "Birta Writer";
    const i18nScript = `window.__i18n=${JSON.stringify({ translations, isMac, debugMode, codeBlockAutoConvert, smartLinks, pasteUnfurl, calcEnabled, calcAutoInsert, embedsEnabled, checklistSinkChecked, codeBlockWordWrap, tocAutoHideThreshold, frontmatterExpanded, proofread, toolbar, floatingToolbar, fontPreset, fontStacks, fontSize, contentWidth: contentWidth.mode, maxContentWidth, mermaidTheme, documentUri, productName })};`;
    const bodyClasses = [
        isAutoWidth ? "editor-width-auto" : "",
        codeBlockWordWrap ? "code-block-word-wrap" : "",
        tocRight ? "toc-right" : "",
        blockHandlesBodyClass(blockHandles) ?? "",
        ...foldingBodyClasses(folding.controls, folding.enabled),
    ].filter(Boolean).join(" ");

    return `<!DOCTYPE html>
<html lang="${vscode.env.language}"${contentFontStyleAttr}>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}' ${webview.cspSource};
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
