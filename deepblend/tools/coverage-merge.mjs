#!/usr/bin/env node
/**
 * The merge behind `coverage-probe.mjs` — and the four wrong answers that came before it.
 *
 * WHY THIS IS A MODULE AND NOT A FUNCTION IN THE PROBE
 * ---------------------------------------------------
 * The probe's reading is line numbers from many processes read against source text on disk, and every
 * way it has been wrong was a MERGE rule, not a collection failure. A rule that can only be exercised
 * by running the whole acceptance suite is a rule nobody checks — and this one has been wrong four
 * times, each caught by a number looking odd rather than by a test:
 *
 *   1. pushing every report's ranges into ONE list, so a range covered by one process and zero in
 *      another counted as dark: the contract layer and the whole suite reported the SAME 63.6%;
 *   2. filtering zero ranges by containment alone reported `JournalTail.drain` as 56 dark lines
 *      although it had run 101 times — one process contributed a whole-body `count: 0` range;
 *   3. dropping any zero range containing a positive one reported every file as 0% dark, because the
 *      module wrapper contains everything;
 *   4. MEASURED in round 27, and this is the one the rule below exists for: V8 emits a zero-count
 *      range for a SUB-EXPRESSION that never ran, and judging a line by its whole span let that range
 *      blacken it. `const version = typeof studio.hostApiVersion === 'function' ? … : 0` carries a
 *      zero-count range starting 62 characters in — the untaken `? studio.hostApiVersion()` arm — so
 *      the line was reported as never executed although thirteen processes had executed it, and the
 *      `if (…) return null` on the next line (whose zero range covered only `return null`) with it.
 *      A dark list that sends someone to write a test for code that already runs costs a round.
 *
 * WHAT THE READING NOW MEANS, EXACTLY
 * -----------------------------------
 * A line is judged by the INNERMOST RANGE COVERING ITS FIRST CODE CHARACTER — its statement start —
 * and is covered when that range has a positive count. That keeps everything the block tree was for,
 * and drops the false dark lines:
 *
 *   - a never-called function: its own body range (count 0) is the innermost at every line start
 *     inside it, so its lines stay dark;
 *   - a branch that never ran, written on its own line: the branch's zero-count range covers that
 *     line's first code character, so it stays dark;
 *   - a line whose ternary arm was never taken: the zero range starts mid-line, after the statement
 *     start, so the line reads as executed — which it was;
 *   - the module wrapper (count 1, whole file) is the outermost range and never wins inside a
 *     function, or every loaded file would read as fully covered (defect 3).
 *
 * The price is stated rather than hidden: THIS IS NOT BRANCH COVERAGE. An untaken arm on a line that
 * ran is invisible here; what stays visible is any body or branch that has a line of its own.
 *
 * THE FIFTH WRONG ANSWER, MEASURED IN ROUND 91 AND NOT YET FIXED BY A RULE
 * -----------------------------------------------------------------------
 * V8 gives the ALTERNATE OF A MULTI-LINE TERNARY a zero-count range whose span runs PAST the expression
 * — over the statements that follow it. Because this rule judges a line by the innermost range covering
 * its first code character, those following statements are reported as never executed although the
 * function ran. MEASURED on `resumeRenderJob`'s checkpoint preference: the range `3083-3092` had count 0
 * while the enclosing function `3049-3136` had count 3, so lines 3087-3092 read dark — and a temporary
 * `process.stderr.write` on line 3088 printed twice, which is what a false dark line looks like from the
 * inside.
 *
 * No span heuristic separates this from a TRUE dark line, and both alternatives were measured rather than
 * assumed: judging a line by ANY positive covering range calls every named dead branch covered (the body
 * range of `errors.push({ … })` is inside a function that ran), and "the blackening zero range starts on
 * an earlier line" is true of 42 of the 48 dark lines in that reading, including all the true ones.
 *
 * So the rule stands, and the COST IS PAID AT THE SOURCE: a multi-line ternary alternate in product code
 * buys the reading a false dark line. Write it as an `if`/`else` — which is what round 91 did to the code
 * above, after which those five lines read as executed — and check a suspect by instrumentation before
 * writing a test for it.
 *
 * Owner: DeepBlend Studio — M5
 */

/**
 * The byte offset where each line starts, so a range can be turned into line numbers.
 *
 * @param {string} text
 * @returns {number[]}
 */
export function lineStartsOf(text) {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) starts.push(index + 1)
  return starts
}

/**
 * A byte offset as a 1-based line number, by binary search over `lineStartsOf`.
 *
 * @param {number[]} lineStarts
 * @param {number} offset
 * @returns {number}
 */
export function lineAt(lineStarts, offset) {
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (lineStarts[middle] <= offset) low = middle
    else high = middle - 1
  }
  return low + 1
}

/**
 * Can this line ever be EXECUTED?
 *
 * A comment or a blank line has no execution to be missing, so counting it as "never executed" is a
 * category error — and it was not a small one: the first reading reported comment-only lines as dark,
 * and after a test was written for `render-journal.js` most of what stayed "dark" in it was prose.
 *
 * The approximation is deliberately simple — trim, then `//`, `*`, `/*` — because a real lexer here
 * would be a second parser kept in step with the source for a number that is a question, not a
 * verdict. Its known error is a comment-only line inside a template literal, which does not exist in
 * this repository and would be reported as covered-but-not-executed rather than the reverse.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function cannotExecute(text) {
  const trimmed = text.trim()
  return trimmed.length === 0 || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

/**
 * Every range one process reported for one script, flattened out of its functions.
 *
 * @param {{functions?: {ranges?: {startOffset: number, endOffset: number, count: number}[]}[]}} script
 * @returns {{startOffset: number, endOffset: number, count: number}[]}
 */
export function rangesOf(script) {
  const ranges = []
  for (const fn of script?.functions ?? []) ranges.push(...(fn.ranges ?? []))
  return ranges
}

/**
 * Nest V8's flat range list into the block tree it describes.
 *
 * The first range of a function is its body; every other range is a block nested somewhere inside it,
 * and a nesting range's count is never higher than its parent's. Sorting by start-then-widest and
 * keeping a stack rebuilds that tree, one tree per script: the module wrapper is the root and every
 * function body hangs off it.
 *
 * @param {{startOffset: number, endOffset: number, count: number}[]} ranges
 * @returns {{startOffset: number, endOffset: number, count: number, children: object[]}[]}
 */
export function rangesToTree(ranges) {
  const sorted = [...ranges].sort((left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset)
  const roots = []
  const stack = []
  for (const range of sorted) {
    if (range.endOffset <= range.startOffset) continue
    const node = { startOffset: range.startOffset, endOffset: range.endOffset, count: range.count, children: [] }
    while (stack.length > 0) {
      const parent = stack[stack.length - 1]
      if (parent.startOffset <= node.startOffset && parent.endOffset >= node.endOffset) break
      stack.pop()
    }
    if (stack.length === 0) roots.push(node)
    else stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return roots
}

/**
 * The offset of the first character of a line that is not whitespace, or `null` for a blank line.
 *
 * @param {string} text
 * @param {number[]} lineStarts
 * @param {number} line - 1-based
 * @returns {number|null}
 */
export function firstCodeOffset(text, lineStarts, line) {
  const start = lineStarts[line - 1]
  if (start === undefined) return null
  const end = line < lineStarts.length ? lineStarts[line] : text.length
  for (let offset = start; offset < end; offset += 1) {
    const character = text[offset]
    if (character !== ' ' && character !== '\t' && character !== '\r' && character !== '\n') return offset
  }
  return null
}

/**
 * The line numbers ONE process executed in one file.
 *
 * The judge is the innermost range covering each line's FIRST CODE CHARACTER (see the header): the
 * statement start is what "did this line run" is about, and it is what keeps a zero-count range for an
 * untaken sub-expression from blackening the line the expression lives on.
 *
 * @param {{startOffset: number, endOffset: number, count: number}[]} ranges
 * @param {number[]} lineStarts
 * @param {string} text
 * @returns {Set<number>}
 */
export function executedLines(ranges, lineStarts, text) {
  /** @type {Map<number, {depth: number, count: number}>} */
  const verdict = new Map()
  const visit = (node, depth) => {
    const first = lineAt(lineStarts, node.startOffset)
    const last = lineAt(lineStarts, Math.max(node.startOffset, node.endOffset - 1))
    for (let line = first; line <= last; line += 1) {
      const anchor = firstCodeOffset(text, lineStarts, line)
      if (anchor === null) continue
      // The anchor must be INSIDE this range: a range that merely spans the line does not judge it.
      if (anchor < node.startOffset || anchor >= node.endOffset) continue
      const previous = verdict.get(line)
      if (previous === undefined || depth > previous.depth) verdict.set(line, { depth, count: node.count })
    }
    for (const child of node.children) visit(child, depth + 1)
  }
  for (const root of rangesToTree(ranges)) visit(root, 0)

  const covered = new Set()
  for (const [line, entry] of verdict) if (entry.count > 0) covered.add(line)
  return covered
}

/**
 * Merge every process's report into one answer per file.
 *
 * PER PROCESS, THEN UNIONED — never one shared range list. That is defect 1 in the header: a range
 * that is positive in one process and zero in another must not cancel out, because the question is
 * "did ANY process execute this line".
 *
 * @param {{url: string, functions?: object[]}[]} scripts - every script entry from every report.
 * @param {(path: string) => string} readText - resolves a script's path to its source, so a caller
 *   (and a test) decides what "the source" is.
 * @returns {Map<string, {text: string, lineStarts: number[], executed: Set<number>, seen: boolean}>}
 */
export function mergeReports(scripts, readText) {
  const byFile = new Map()
  for (const script of scripts) {
    if (typeof script?.url !== 'string') continue
    const path = script.url.replace('file://', '')
    const ranges = rangesOf(script)
    if (ranges.length === 0) continue
    let entry = byFile.get(path)
    if (entry === undefined) {
      const text = readText(path)
      if (text === null) continue
      entry = { text, lineStarts: lineStartsOf(text), executed: new Set(), seen: true }
      byFile.set(path, entry)
    }
    for (const line of executedLines(ranges, entry.lineStarts, entry.text)) entry.executed.add(line)
  }
  return byFile
}
