import * as vscode from "vscode";

/**
 * The file's text as `TextDocument.getText()` would report it: decoded UTF-8
 * with any BOM stripped.
 *
 * One definition, because both callers compare the result against a live
 * buffer and act on the verdict — the disk-drift badge (src/diskDrift.ts) and
 * the phantom-dirty settle (src/phantomDirty.ts), which reverts on equality.
 * A decode that differed between them by a single leading code unit would make
 * one of the two wrong about a file it can read perfectly well.
 */
export async function readDiskText(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString("utf8");
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
