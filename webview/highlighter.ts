// refractor's exports map: "./*" → "./lang/*.js", so import paths omit "lang/"
import { refractor } from "refractor/core";
import bash from "refractor/bash";
import batch from "refractor/batch";
import c from "refractor/c";
import clojure from "refractor/clojure";
import cmake from "refractor/cmake";
import coffeescript from "refractor/coffeescript";
import cpp from "refractor/cpp";
import csharp from "refractor/csharp";
import css from "refractor/css";
import csv from "refractor/csv";
import dart from "refractor/dart";
import diff from "refractor/diff";
import docker from "refractor/docker";
import elixir from "refractor/elixir";
import erlang from "refractor/erlang";
import fsharp from "refractor/fsharp";
import git from "refractor/git";
import glsl from "refractor/glsl";
import go from "refractor/go";
import gradle from "refractor/gradle";
import graphql from "refractor/graphql";
import groovy from "refractor/groovy";
import haskell from "refractor/haskell";
import hcl from "refractor/hcl";
import markup from "refractor/markup"; // html
import http from "refractor/http";
import ini from "refractor/ini";
import java from "refractor/java";
import javascript from "refractor/javascript";
import jq from "refractor/jq";
import json from "refractor/json";
import json5 from "refractor/json5";
import kotlin from "refractor/kotlin";
import latex from "refractor/latex";
import less from "refractor/less";
import log from "refractor/log";
import lua from "refractor/lua";
import makefile from "refractor/makefile";
import markdown from "refractor/markdown";
import matlab from "refractor/matlab";
import nginx from "refractor/nginx";
import objectivec from "refractor/objectivec";
import perl from "refractor/perl";
import php from "refractor/php";
import plantUml from "refractor/plant-uml";
import powershell from "refractor/powershell";
import properties from "refractor/properties";
import protobuf from "refractor/protobuf";
import python from "refractor/python";
import r from "refractor/r";
import ruby from "refractor/ruby";
import rust from "refractor/rust";
import sass from "refractor/sass";
import scala from "refractor/scala";
import scss from "refractor/scss";
import solidity from "refractor/solidity";
import sql from "refractor/sql";
import swift from "refractor/swift";
import toml from "refractor/toml";
import typescript from "refractor/typescript";
import vim from "refractor/vim";
import wasm from "refractor/wasm";
import wgsl from "refractor/wgsl";
import yaml from "refractor/yaml";
import zig from "refractor/zig";
import { normalizeCodeLanguage } from "./codeLanguages";

[
    bash, batch, c, clojure, cmake, coffeescript, cpp, csharp, css, csv,
    dart, diff, docker, elixir, erlang, fsharp, git, glsl, go, gradle,
    graphql, groovy, haskell, hcl, markup, http, ini, java, javascript,
    jq, json, json5, kotlin, latex, less, log, lua, makefile, markdown,
    matlab, nginx, objectivec, perl, php, plantUml, powershell, properties,
    protobuf, python, r, ruby, rust, sass, scala, scss, solidity, sql,
    swift, toml, typescript, vim, wasm, wgsl, yaml, zig,
].forEach((lang) => refractor.register(lang));

// ── Custom Mermaid syntax highlighting ─────────────────────────────────
if (!refractor.registered('mermaid')) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mermaidSyntax: any = function (Prism: any) {
        Prism.languages['mermaid'] = {
            comment: { pattern: /%%[^\r\n]*/, greedy: true },
            string:  { pattern: /"[^"]*"/, greedy: true },
            label:   { pattern: /\|[^|]*\|/, greedy: true },
            bracket: { pattern: /\[(?:[^\[\]]|\[[^\[\]]*\])*\]|\{[^{}]*\}|\([^()]*\)|\(\([^()]*\)\)/, greedy: true },
            keyword: /\b(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|erDiagram|gantt|pie|showData|mindmap|timeline|gitGraph|quadrantChart|xychart-beta|sankey-beta|block-beta|architecture-beta|LR|RL|TD|TB|BT|subgraph|end|participant|actor|Note|note|over|loop|opt|alt|else|critical|break|par|and|rect|activate|deactivate|title|section|class|state|direction|as|autonumber|link|style|classDef|fill|stroke|color)\b/i,
            arrow:   /(?:-->|-->>|->>|--[ox*]|<-->|<-->>|<<-->|o--o|\*--\*|\.->|==>|==|--)/,
            number:  /\b\d+(?:\.\d+)?\b/,
            punctuation: /[[\]{}()]/,
        };
    };
    mermaidSyntax.displayName = 'mermaid';
    mermaidSyntax.aliases = [];
    refractor.register(mermaidSyntax);
}

// ── HAST → HTML string (only handles token spans; no hast-util-to-html needed) ──
function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HastNode = { type: string; value?: string; properties?: { className?: string[] }; children?: HastNode[] };

function hastToHtml(node: HastNode): string {
    if (node.type === "text") return escapeHtml(node.value ?? "");
    if (node.type === "element") {
        const cls = (node.properties?.className)?.join(" ") || "";
        const inner = node.children?.map(hastToHtml).join("") ?? "";
        return cls ? `<span class="${cls}">${inner}</span>` : inner;
    }
    if (node.type === "root")
        return node.children?.map(hastToHtml).join("") ?? "";
    return "";
}

/**
 * Syntax-highlight code with refractor, returning an HTML string with token spans.
 * If the language is unsupported or highlighting fails, returns HTML-escaped plain text.
 */
export function highlight(code: string, lang: string): string {
    const normalizedLang = normalizeCodeLanguage(lang);
    if (!normalizedLang || !refractor.registered(normalizedLang)) return escapeHtml(code);
    try {
        const tree = refractor.highlight(code, normalizedLang);
        return hastToHtml(tree);
    } catch {
        return escapeHtml(code);
    }
}

export { refractor };
