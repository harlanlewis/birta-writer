export type CodeLanguage = [value: string, label: string, aliases?: string[]];

export const CODE_LANGUAGES: CodeLanguage[] = [
    ["", "Plain Text", ["txt", "text", "plaintext", "plain", "test"]],
    ["bash", "Bash / Shell", ["sh", "shell", "zsh"]],
    ["batch", "Batch", ["bat", "cmd"]],
    ["c", "C"],
    ["calc", "Calculation", ["calculation"]],
    ["clojure", "Clojure", ["clj"]],
    ["cmake", "CMake"],
    ["coffeescript", "CoffeeScript", ["coffee"]],
    ["cpp", "C++", ["c++", "cc", "cxx", "hpp"]],
    ["csharp", "C#", ["cs"]],
    ["css", "CSS"],
    ["csv", "CSV"],
    ["dart", "Dart"],
    ["diff", "Diff", ["patch"]],
    ["docker", "Dockerfile", ["dockerfile"]],
    // Graphviz. The VALUE is `dot` rather than `graphviz` because it has to
    // match refractor's grammar name for the code view to highlight at all
    // (`plant-uml` above is the same arrangement), while the LABEL is what the
    // picker shows and `graphviz` is the alias people actually type in a fence.
    // The user's own spelling is what stays in the file: normalization feeds
    // the CSS class and the previewable check, never the stored attribute.
    ["dot", "Graphviz", ["graphviz", "gv"]],
    ["elixir", "Elixir", ["ex", "exs"]],
    ["erlang", "Erlang", ["erl"]],
    ["fsharp", "F#", ["fs", "fsi", "fsx"]],
    ["git", "Git"],
    ["glsl", "GLSL"],
    ["go", "Go", ["golang"]],
    ["gradle", "Gradle"],
    ["graphql", "GraphQL", ["gql"]],
    ["groovy", "Groovy"],
    ["haskell", "Haskell", ["hs"]],
    ["hcl", "HCL", ["tf", "terraform"]],
    ["html", "HTML", ["htm", "markup", "xml"]],
    ["http", "HTTP"],
    ["ini", "INI", ["conf", "cfg"]],
    ["java", "Java"],
    ["javascript", "JavaScript", ["js", "jsx", "mjs", "cjs"]],
    ["jq", "jq"],
    ["json", "JSON", ["jsonc"]],
    ["json5", "JSON5"],
    ["kotlin", "Kotlin", ["kt", "kts"]],
    ["latex", "LaTeX", ["tex"]],
    ["less", "Less"],
    ["log", "Log"],
    ["lua", "Lua"],
    ["makefile", "Makefile", ["make"]],
    ["markdown", "Markdown", ["md"]],
    ["matlab", "MATLAB"],
    ["mermaid", "Mermaid", ["mmd"]],
    ["nginx", "Nginx"],
    ["objectivec", "Objective-C", ["objc", "m", "mm"]],
    ["perl", "Perl", ["pl", "pm"]],
    ["php", "PHP"],
    ["plant-uml", "PlantUML", ["plantuml", "puml"]],
    ["powershell", "PowerShell", ["ps1", "psm1", "pwsh"]],
    ["properties", "Properties"],
    ["protobuf", "Protocol Buffers", ["proto"]],
    ["python", "Python", ["py"]],
    ["r", "R"],
    ["ruby", "Ruby", ["rb"]],
    ["rust", "Rust", ["rs"]],
    ["sass", "Sass"],
    ["scala", "Scala"],
    ["scss", "SCSS"],
    ["solidity", "Solidity", ["sol"]],
    ["sql", "SQL"],
    // SVG. No aliases: `xml` is already an alias of `html` above, and a fence
    // that renders a picture is a different promise from one that highlights
    // markup, so the two must not converge on a spelling. The VALUE doubles as
    // refractor's grammar name (`markup` registers `svg` among its aliases), so
    // the code view highlights without a second mapping.
    ["svg", "SVG"],
    ["swift", "Swift"],
    ["toml", "TOML"],
    ["typescript", "TypeScript", ["ts", "tsx"]],
    ["vim", "Vim Script", ["vimscript"]],
    ["wasm", "WebAssembly", ["wat", "wast"]],
    ["wgsl", "WGSL"],
    ["yaml", "YAML", ["yml"]],
    ["zig", "Zig"],
];

export function normalizeCodeLanguage(lang: string): string {
    const normalized = lang.trim().toLowerCase();
    const match = CODE_LANGUAGES.find(([value, , aliases]) => (
        value === normalized || aliases?.includes(normalized)
    ));
    return match?.[0] ?? normalized;
}
