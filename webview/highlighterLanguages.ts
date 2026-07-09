/**
 * Refractor language grammars, split into their own lazily-loaded chunk.
 *
 * These ~66 Prism grammars total ~155 KB and were previously imported and
 * registered synchronously at boot from highlighter.ts, so every editor launch
 * paid to parse them even for documents with no code. They now live behind
 * `ensureGrammars()` (see highlighter.ts): loaded before editor creation only
 * when the document actually contains a code fence, and on demand when a code
 * block is added later.
 *
 * refractor's exports map "./*" → "./lang/*.js", so import paths omit "lang/".
 */
import type { Refractor } from "refractor/core";
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

/** Register every bundled grammar on the shared refractor instance (idempotent). */
export function registerGrammars(refractor: Refractor): void {
    [
        bash, batch, c, clojure, cmake, coffeescript, cpp, csharp, css, csv,
        dart, diff, docker, elixir, erlang, fsharp, git, glsl, go, gradle,
        graphql, groovy, haskell, hcl, markup, http, ini, java, javascript,
        jq, json, json5, kotlin, latex, less, log, lua, makefile, markdown,
        matlab, nginx, objectivec, perl, php, plantUml, powershell, properties,
        protobuf, python, r, ruby, rust, sass, scala, scss, solidity, sql,
        swift, toml, typescript, vim, wasm, wgsl, yaml, zig,
    ].forEach((lang) => refractor.register(lang));
}
