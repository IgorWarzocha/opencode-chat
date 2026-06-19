#!/usr/bin/env bun
/**
 * Post-bundle fixup: make plugin/opencode-chat/ self-contained and portable.
 *
 * bun build bundles index.ts into plugin/opencode-chat/index.js. It statically
 * resolves some native addons (e.g. @anush008/tokenizers — copied + renamed with
 * a hash suffix, require rewritten to ./relative) but CANNOT resolve dynamic
 * template-literal requires like onnxruntime-node's
 * `../bin/napi-v3/${process.platform}/${process.arch}/onnxruntime_binding.node`.
 *
 * This script scans the bundled index.js for every native .node require, copies
 * the native binary AND all sibling files (shared libraries like .dylib/.so/.dll)
 * from the original node_modules source directory into plugin/opencode-chat/, and
 * rewrites each dynamic require to a relative ./path so the plugin dir works when
 * copied verbatim into ~/.opencode/config/plugins/. Idempotent and platform-agnostic.
 */
import * as fs from "fs"
import * as path from "path"
import {fileURLToPath} from "url"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..")
const PLUGIN_DIR = path.join(REPO_ROOT, "plugin", "opencode-chat")
const INDEX_PATH = path.join(PLUGIN_DIR, "index.js")

/** A native .node require found in the bundled index.js. */
interface NativeRequire {
  /** The callee token, e.g. "__require" or "require". */
  callee: string
  /** Raw argument expression between the parens, e.g. `` `../bin/...` ``. */
  argExpr: string
  /** Evaluated concrete path string, e.g. "../bin/napi-v3/darwin/arm64/onnxruntime_binding.node". */
  evaluatedPath: string
  /** Zero-based line index in the source array. */
  lineIndex: number
  /** Char index on the line where the callee token starts. */
  callStart: number
  /** Char index on the line of the matching closing ")". */
  parenEnd: number
}

/**
 * Find the matching closing paren for the "(" at `openParenIdx` on `line`.
 * Tracks single/double/backtick string state so parens inside string literals
 * and `${...}` template substitutions are treated as opaque content. Returns
 * the index of the matching ")" or -1 if unbalanced on this line.
 */
function findMatchingParen(line: string, openParenIdx: number): number {
  let depth = 0
  let inString: '"' | "'" | "`" | null = null
  let escaped = false
  for (let i = openParenIdx; i < line.length; i++) {
    const ch = line[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (inString !== null) {
      if (ch === inString) inString = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch
      continue
    }
    if (ch === "(") {
      depth++
    } else if (ch === ")") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Evaluate a require argument expression to a concrete string. Uses `new Function`
 * to resolve template literals (`${process.platform}`, `${process.arch}`) and
 * string concatenation against the current process's environment. Returns null if
 * the expression does not evaluate to a string.
 */
function evaluateRequireArg(argExpr: string): string | null {
  try {
    // eslint-disable-next-line no-new-func
    const result = new Function(`return (${argExpr})`)()
    return typeof result === "string" ? result : null
  } catch {
    return null
  }
}

/**
 * Find every native .node require on a single line. Matches `__require(...)` and
 * `require(...)` calls whose argument evaluates to a string ending in ".node".
 * Does NOT match `require_binding(` / `__commonJS(` / `require_cjs(` (the char
 * after `require`/`__` is not `(` or whitespace).
 */
function findNativeRequires(lines: string[], lineIndex: number): NativeRequire[] {
  const line = lines[lineIndex]
  const results: NativeRequire[] = []
  const callRe = /(?:__)?require\s*\(/g
  let match: RegExpExecArray | null
  while ((match = callRe.exec(line)) !== null) {
    const callee = match[0].replace(/\s*\($/, "")
    const openParen = match.index + match[0].length - 1
    const parenEnd = findMatchingParen(line, openParen)
    if (parenEnd === -1) continue
    const argExpr = line.slice(openParen + 1, parenEnd).trim()
    if (argExpr.length === 0) continue
    const evaluatedPath = evaluateRequireArg(argExpr)
    if (evaluatedPath === null || !evaluatedPath.endsWith(".node")) continue
    results.push({
      callee,
      argExpr,
      evaluatedPath,
      lineIndex,
      callStart: match.index,
      parenEnd,
    })
  }
  return results
}

/** Read the index.js, returning its lines (EOL-stripped) and detected EOL. */
function readIndex(): { lines: string[]; eol: string } {
  const source = fs.readFileSync(INDEX_PATH, "utf8")
  const eol = source.includes("\r\n") ? "\r\n" : "\n"
  const lines = source.split(/\r?\n/)
  return {lines, eol}
}

/** Build an array mapping each line index to its preceding `// node_modules/` marker (or null). */
function buildMarkerMap(lines: string[]): (string | null)[] {
  const markerRe = /^\/\/\s+(node_modules\/.+)$/
  let current: string | null = null
  return lines.map((line) => {
    const m = line.match(markerRe)
    if (m) current = m[1]
    return current
  })
}

/** Copy all regular files from `srcDir` into `PLUGIN_DIR`, erroring on cross-dir basename collisions. */
function copyNativeDir(srcDir: string, copiedFrom: Map<string, string>): void {
  const entries = fs.readdirSync(srcDir, {withFileTypes: true})
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const existingDir = copiedFrom.get(entry.name)
    if (existingDir !== undefined && existingDir !== srcDir) {
      throw new Error(
        `[plugin] collision: file "${entry.name}" would be copied from two source dirs:\n` +
        `  ${existingDir}\n  ${srcDir}`,
      )
    }
    copiedFrom.set(entry.name, srcDir)
    fs.copyFileSync(path.join(srcDir, entry.name), path.join(PLUGIN_DIR, entry.name))
  }
}

/** Re-scan the (possibly patched) index.js and assert every .node require is ./-relative + present. */
function verify(): void {
  const {lines} = readIndex()
  const markerMap = buildMarkerMap(lines)
  for (let i = 0; i < lines.length; i++) {
    const requires = findNativeRequires(lines, i)
    for (const req of requires) {
      if (!req.evaluatedPath.startsWith("./")) {
        throw new Error(
          `[plugin] verify: unresolved dynamic .node require remains on line ${i + 1} ` +
          `(marker: ${markerMap[i] ?? "<none>"}): ${req.callee}(${req.argExpr})`,
        )
      }
      const target = path.join(PLUGIN_DIR, req.evaluatedPath)
      if (!fs.existsSync(target)) {
        throw new Error(
          `[plugin] verify: .node file missing from plugin dir: ${target} ` +
          `(required on line ${i + 1})`,
        )
      }
    }
  }
}

function main(): void {
  if (!fs.existsSync(PLUGIN_DIR)) {
    throw new Error(
      `[plugin] plugin dir not found: ${PLUGIN_DIR}\n  Run "bun run bundle" first.`,
    )
  }
  if (!fs.existsSync(INDEX_PATH)) {
    throw new Error(
      `[plugin] bundled index.js not found: ${INDEX_PATH}\n  Run "bun run bundle" first.`,
    )
  }

  const {lines, eol} = readIndex()
  const markerMap = buildMarkerMap(lines)

  const allRequires: NativeRequire[] = []
  for (let i = 0; i < lines.length; i++) {
    allRequires.push(...findNativeRequires(lines, i))
  }

  if (allRequires.length === 0) {
    console.log("[plugin] no native .node requires found; nothing to do")
    return
  }

  // Process requires right-to-left within each line so that rewriting one
  // require does not shift the character indices of another on the same line.
  allRequires.sort((a, b) => a.lineIndex - b.lineIndex || b.callStart - a.callStart)

  const copiedFrom = new Map<string, string>()
  const newLines = [...lines]
  let modified = false

  for (const req of allRequires) {
    const {callee, argExpr, evaluatedPath, lineIndex, callStart, parenEnd} = req
    const lineNo = lineIndex + 1

    if (evaluatedPath.startsWith("./")) {
      const target = path.join(PLUGIN_DIR, evaluatedPath)
      if (!fs.existsSync(target)) {
        throw new Error(
          `[plugin] relative .node require on line ${lineNo} points to missing file: ${target}\n` +
          `  require: ${callee}(${argExpr})`,
        )
      }
      continue
    }

    const marker = markerMap[lineIndex]
    if (marker === null) {
      throw new Error(
        `[plugin] .node require on line ${lineNo} has no preceding "// node_modules/..." marker; ` +
        `cannot resolve source dir.\n  require: ${callee}(${argExpr})`,
      )
    }

    const sourceDir = path.dirname(marker)
    const absoluteSourceDir = path.resolve(REPO_ROOT, sourceDir)
    const absoluteNodeFile = path.resolve(absoluteSourceDir, evaluatedPath)
    if (!fs.existsSync(absoluteNodeFile)) {
      throw new Error(
        `[plugin] resolved .node file does not exist: ${absoluteNodeFile}\n` +
        `  (marker: ${marker}, require: ${callee}(${argExpr}) on line ${lineNo})`,
      )
    }

    const nodeFileDir = path.dirname(absoluteNodeFile)
    const nodeBasename = path.basename(absoluteNodeFile)

    copyNativeDir(nodeFileDir, copiedFrom)

    const line = newLines[lineIndex]
    const before = line.slice(0, callStart)
    const after = line.slice(parenEnd + 1)
    newLines[lineIndex] = `${before}${callee}("./${nodeBasename}")${after}`
    modified = true
    console.log(`[plugin] copied ${nodeBasename} (+ siblings) from ${nodeFileDir}`)
    console.log(`[plugin] rewrote line ${lineNo}: ${callee}("./${nodeBasename}")`)
  }

  if (modified) {
    fs.writeFileSync(INDEX_PATH, newLines.join(eol), "utf8")
    console.log("[plugin] index.js patched")
  } else {
    console.log("[plugin] no dynamic requires needed rewriting; index.js unchanged")
  }

  verify()
  console.log("[plugin] verification passed: all .node requires are relative and resolvable")
}

main()
