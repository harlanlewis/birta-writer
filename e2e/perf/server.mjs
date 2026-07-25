/**
 * The static file servers both perf harnesses drive Chromium against.
 *
 * `serve()` (single bundle) and `serveAB()` (two bundles side by side) were
 * duplicated across e2e/perf.mjs and e2e/perf-typing.mjs; the typing A/B needed
 * a third copy, so they live here instead. Behaviour is unchanged — the only
 * reason this is a module is that two callers need the same two servers.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = dirname(dirname(fileURLToPath(new URL(".", import.meta.url))));
export const suiteDir = join(repoRoot, "e2e", "perf");

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".map": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
};

async function sendFile(res, file) {
    try {
        const body = await readFile(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
    } catch {
        res.writeHead(404);
        res.end("not found");
    }
}

const safeRel = (p) => normalize(p).replace(/^([/\\]|\.\.)+/, "");

/** Serve the perf stub from e2e/perf/, with `dist/*` resolved from the repo root. */
export function serve() {
    return createServer(async (req, res) => {
        const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
        // Chromium auto-requests /favicon.ico on the first page of a context; a
        // 404 there logs a console error that would abort the strict runners.
        if (urlPath === "/favicon.ico") { res.writeHead(204); res.end(); return; }
        const rel = safeRel(urlPath);
        const base = rel.startsWith("dist/") ? repoRoot : suiteDir;
        await sendFile(res, join(base, rel === "" || rel === "." ? "index.html" : rel));
    });
}

/**
 * A/B server: serves the SAME perf stub (index.html) at /base/ and /head/, with
 * each variant's bundle under /<variant>/dist/*. The stub's relative asset refs
 * (`dist/webview.js`, `dist/webview.css`) resolve against the /<variant>/ page
 * URL, so no templating is needed — /base/ loads baseDir, /head/ loads headDir.
 */
export function serveAB(variants) {
    return createServer(async (req, res) => {
        const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
        if (urlPath === "/favicon.ico") { res.writeHead(204); res.end(); return; }
        const m = urlPath.match(/^\/(base|head)(\/.*)?$/);
        if (!m) { res.writeHead(404); res.end("not found"); return; }
        const rest = (m[2] ?? "/").replace(/^\/+/, "");
        let file;
        if (rest === "" || rest === "index.html") {
            file = join(suiteDir, "index.html");
        } else if (rest.startsWith("dist/")) {
            file = join(variants[m[1]], safeRel(rest.slice("dist/".length)));
        } else {
            file = join(suiteDir, safeRel(rest));
        }
        await sendFile(res, file);
    });
}
