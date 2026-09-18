#!/usr/bin/env node
/**
 * Security-controls contract test — SPEC §15 traced to code, and the gaps named.
 *
 * WHY THIS EXISTS
 * ---------------
 * SPEC §15.2 lists eighteen things the provider "必须实现" (must implement), and SPEC §15.1
 * is a twelve-row permission policy. Neither list had ever been enumerated against the code:
 * `milestone-status.md` §7 recorded five deviations, all from M1/M2, and none of them about
 * §15. Writing the table for `deepblend/docs/security.md` was the first time anybody asked
 * which of the eighteen were actually there — and the answer was not "all of them". Four were
 * missing entirely (texture size, mesh face count, CPU/memory/GPU quotas, log redaction), one
 * was half there (MIME sniffing), two had no test at all though the code was right
 * (`--factory-startup`, the argv discipline), and one policy row describes a subsystem that
 * does not exist yet (the remote worker, M6).
 *
 * So this file does three things:
 *
 *   1. it reads the requirement lists OUT OF `SPEC.md`, and the tables out of
 *      `deepblend/docs/security.md`, and asserts the two sets are equal — adding a
 *      requirement to the spec forces a row, and a row for a requirement that no longer
 *      exists is an orphan;
 *   2. it asserts every row's implementation pointer and assertion pointer are real: the file
 *      exists and the quoted fragment is IN it, so renaming a check or moving a guard turns
 *      the matrix red instead of leaving a citation to something that is gone;
 *   3. it asserts every row that is not ✅ or ➖ carries a deviation number, and that the
 *      number exists in `milestone-status.md` §7. **A gap that is not written down is the
 *      only thing this repository cannot tolerate**, and this is where that rule is enforced;
 *   4. the two controls that had no test anywhere (`--factory-startup`, and the argv/env
 *      discipline around the spawn) get their assertions here.
 *
 * WHAT IT CANNOT CHECK
 * --------------------
 * That a ✅ row is truly enforced. The matrix points at the assertion that settles it; reading
 * that assertion is the work, and this file only guarantees the pointer is not a lie.
 *
 * Run: node deepblend/tests/contract/security-controls.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from '../../tools/workspace-layout.mjs'

const SECURITY_DOC = join(ROOT, 'deepblend', 'docs', 'security.md')
const SPEC = readFileSync(join(ROOT, 'SPEC.md'), 'utf8')
const security = readFileSync(SECURITY_DOC, 'utf8')
const milestoneStatus = readFileSync(join(ROOT, 'deepblend', 'docs', 'milestone-status.md'), 'utf8')
const provider = readFileSync(join(ROOT, 'packages', 'deepblend', 'provider-local', 'lib', 'index.js'), 'utf8')

/** The lines of SPEC §15.2: a bulleted list of requirements under one heading. */
function spec152Requirements() {
  const start = SPEC.indexOf('### 15.2 Provider 安全')
  assert.notEqual(start, -1, 'SPEC.md no longer has a §15.2 Provider 安全 section')
  const end = SPEC.indexOf('### 15.3', start)
  assert.notEqual(end, -1, 'SPEC.md §15.2 no longer ends at §15.3, so its list cannot be delimited')

  return SPEC.slice(start, end)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).replace(/[；;。.]$/, '').trim())
    .filter(line => line.length > 0)
}

/** The first column of SPEC §15.1's permission table, minus the header rows. */
function spec151Requirements() {
  const start = SPEC.indexOf('### 15.1 权限策略')
  assert.notEqual(start, -1, 'SPEC.md no longer has a §15.1 权限策略 section')
  const end = SPEC.indexOf('### 15.2', start)

  return SPEC.slice(start, end)
    .split('\n')
    .filter(line => line.startsWith('|') && !line.includes('---') && !line.includes('操作'))
    .map(line => line.split('|')[1].trim())
    .filter(cell => cell.length > 0)
}

/**
 * One row of a matrix table in `security.md`.
 *
 * The tables are read by shape rather than by heading: every row starts with a requirement
 * number, and the last cell carries the status marker. That keeps the parser from caring where
 * a section begins, which is the part of a document that moves.
 */
function matrixRows() {
  const rows = []
  for (const line of security.split('\n')) {
    if (!line.startsWith('|') || line.includes('---')) continue
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length !== 5 || !/^\d+$/.test(cells[0])) continue
    rows.push({ number: Number(cells[0]), requirement: cells[1], implementation: cells[2], assertion: cells[3], status: cells[4] })
  }
  return rows
}

/** `true` when the row is declared as met or as not applicable. */
const isGreen = row => row.status.startsWith('✅') || row.status.startsWith('➖')

/** Every `` `path` `` and 「fragment」 pair in a cell, as `{ path, fragment }`. */
function citations(cell) {
  const found = []
  for (const match of cell.matchAll(/`([^`]+)`(?:\s*「([^」]+)」)?/g)) {
    const path = match[1]
    // Only path-shaped tokens are citations; a cell also mentions config keys and codes.
    if (!/^(packages|deepblend)\/[\w./-]+$/.test(path)) continue
    found.push({ path, fragment: match[2] ?? null })
  }
  return found
}

const rows152 = matrixRows()
const spec152 = spec152Requirements()
const spec151 = spec151Requirements()

test('the matrix exists and covers both SPEC §15 lists', () => {
  assert.ok(existsSync(SECURITY_DOC), 'deepblend/docs/security.md is missing, so nothing traces SPEC §15')
  assert.equal(spec152.length, 18, `SPEC §15.2 lists ${spec152.length} requirements, not the 18 this file was written against`)
  assert.ok(spec151.length >= 10, `SPEC §15.1's policy table parsed ${spec151.length} rows, too few — the table was reshaped`)
  assert.ok(rows152.length >= spec152.length, `security.md has ${rows152.length} rows for ${spec152.length} requirements`)
})

test('every requirement the matrix answers is one SPEC actually makes', () => {
  // The reverse direction first: a row for a requirement that was deleted is a citation to
  // nothing, and it is the direction that rots silently.
  const answered = new Set()
  for (const row of rows152) {
    const key = row.requirement.replace(/[；;。.\s—-]+/g, '')
    const matches = [...spec152, ...spec151].filter(requirement => {
      const other = requirement.replace(/[；;。.\s—-]+/g, '')
      return other.includes(key) || key.includes(other)
    })
    assert.ok(
      matches.length > 0,
      `security.md answers "${row.requirement}", which is not a requirement in SPEC §15.1 or §15.2 — a row for a requirement that no longer exists`,
    )
    answered.add(matches[0])
  }

  const unanswered = [...spec152, ...spec151].filter(requirement => !answered.has(requirement))
  assert.deepEqual(
    unanswered,
    [],
    `SPEC requires ${unanswered.join(' / ')}, and the security matrix does not answer ${unanswered.length === 1 ? 'it' : 'them'}`,
  )
})

test('every citation points at a file that exists and a fragment that is in it', () => {
  // Not every cell needs a path — a policy row legitimately names a function, and the
  // assertion column is where the anchor belongs. What must hold is that (a) a row that is
  // presented as met is anchored SOMEWHERE in the repository, and (b) every path it does cite
  // is real and still contains the fragment it quotes. That second half is what makes a rename
  // visible: moving a guard or rewriting a check name turns the matrix red rather than leaving
  // a citation to something that is gone.
  for (const row of rows152) {
    const cited = [...citations(row.implementation), ...citations(row.assertion)]
    if (!row.status.startsWith('❌')) {
      assert.ok(cited.length > 0, `row ${row.number} ("${row.requirement}") is presented as met and cites no file at all`)
    }

    for (const { path, fragment } of cited) {
      const file = join(ROOT, path)
      assert.ok(existsSync(file), `row ${row.number} cites ${path}, which does not exist`)
      if (fragment === null) continue
      assert.ok(
        readFileSync(file, 'utf8').includes(fragment),
        `row ${row.number} cites 「${fragment}」 in ${path}, but that text is not there any more — ` +
          'the matrix is what makes a rename visible',
      )
    }
  }
})

test('every gap the matrix admits is numbered in the deviation register', () => {
  // THE POINT OF THE WHOLE FILE. A control that is missing is survivable; a control that is
  // missing and unrecorded is not, because the next reader will assume it is there.
  const register = milestoneStatus.slice(
    milestoneStatus.indexOf('## 7. 与 SPEC 的偏差'),
    milestoneStatus.indexOf('## 8. 已知问题'),
  )
  assert.ok(register.length > 0, 'milestone-status.md §7 is gone, so there is nowhere to record a deviation')

  const numbered = new Set([...register.matchAll(/^\|\s*(\d+)\s*\|/gm)].map(match => Number(match[1])))
  assert.ok(numbered.size >= 5, `§7 parses ${numbered.size} numbered deviations, which is too few to be the register`)

  for (const row of rows152) {
    if (isGreen(row)) continue
    const reference = /§7\s*#(\d+)/.exec(row.status)
    assert.ok(
      reference !== null,
      `row ${row.number} ("${row.requirement}") is not ✅ or ➖ and carries no \`§7 #N\` — ` +
        'a gap has to be recorded where the deviations live',
    )
    assert.ok(
      numbered.has(Number(reference[1])),
      `row ${row.number} cites deviation §7 #${reference[1]}, and §7 has no such row`,
    )
  }

  // And the other way: a numbered deviation about §15 that no row admits is a gap the matrix
  // is hiding. The register's rows are read for the section reference so this stays narrow —
  // and a row the register has STRUCK THROUGH is resolved, which is how §7 records a
  // deviation that has since been fixed (`~~8~~`). Reading a resolved deviation as still-open
  // would make fixing something turn this test red, which is the wrong direction entirely.
  const securityDeviations = [...register.matchAll(/^\|\s*(\d+)\s*\|([^|]*)\|/gm)]
    .filter(match => !match[2].includes('~~'))
    .filter(match => /§15|安全|配额|纹理|面数|MIME|脱敏|Worker/.test(match[2]))
    .map(match => Number(match[1]))
  const admitted = new Set(rows152.map(row => Number(/§7\s*#(\d+)/.exec(row.status)?.[1] ?? -1)))
  const unadmitted = securityDeviations.filter(number => !admitted.has(number))
  assert.deepEqual(
    unadmitted,
    [],
    `§7 records security deviation(s) ${unadmitted.join(', ')} that the matrix presents as met — one of the two is wrong`,
  )
})

// ---------------------------------------------------------------------------
// The two controls that had no assertion anywhere
// ---------------------------------------------------------------------------

test('the provider starts Blender with the flags the policy depends on', () => {
  // SPEC §15.1 "安装 Add-on 默认禁止" and §15.2 "禁用未知 Add-on" / "禁用 Auto Run 未知脚本"
  // are one flag in practice: `--factory-startup` skips the user's preferences, their add-ons
  // and their startup scripts. The provider passes it — and NOTHING asserted that until this
  // test, which is the same "implemented but nobody checks" shape §12's CI finding had.
  //
  // It is asserted statically, and that is a deliberate, labelled limit: the contract layer
  // cannot launch Blender, so what it can honestly check is that every argv the provider builds
  // carries the flag. `hardening.e2e.mjs` exercises the same provider for real.
  const argvBlocks = [...provider.matchAll(/const argv = \[([\s\S]*?)\n {4}\]/g)].map(match => match[1])
  assert.ok(argvBlocks.length >= 2, `the provider builds ${argvBlocks.length} argv arrays, not the two this test describes`)

  for (const block of argvBlocks) {
    assert.ok(block.includes("'--background'"), 'an argv without --background would open a window and never return')
    assert.ok(block.includes("'--factory-startup'"), 'an argv without --factory-startup loads the user\'s add-ons and startup scripts')
    assert.ok(block.includes("'--python'"), 'an argv without --python would be Blender with no instructions')
  }

  // And the resolved executable is first, because Blender is the program being run rather
  // than one of its arguments.
  for (const block of argvBlocks) {
    assert.match(block.trimStart(), /^resolvedExecutable\.resolved,/, 'an argv does not start with the resolved Blender executable')
  }
})

test('the provider never reaches a shell, and hands the child no secret', () => {
  // SPEC §15.2 "参数数组启动进程" and "禁止 Shell 拼接", plus §15.5's "不传递敏感环境变量".
  // Structural, but the structure IS the control: a shell string is a control that can be
  // lost by one line, and an env passthrough is how an API key reaches a renderer.
  //
  // THE ONE EXCEPTION, AND WHY IT IS ALLOWED. `discoverBlenderOnPath()` calls `spawnSync`
  // directly: it is the settings card's "suggest a path" affordance, it is off the execution
  // path, it passes an argv array, and its own doc comment says all of that. Asserting "no
  // direct child_process at all" would have been a rule the code already and deliberately
  // breaks, so the assertion pins the exception instead — one import, one call, array form,
  // inside that helper. What it costs is also real and worth naming: a candidate that hangs
  // on `--version` blocks the event loop for up to its 20 s timeout, because there is no
  // asynchronous form of "look before you leap" here.
  const direct = [...provider.matchAll(/spawnSync\(/g)].length
  assert.equal(direct, 1, `the provider calls spawnSync ${direct} times; the discovery affordance is the only one allowed`)
  assert.match(provider, /import \{ spawnSync \} from 'node:child_process'/, 'the provider no longer imports exactly spawnSync')
  assert.ok(
    !/\bexecSync|\bexec\(|shell\s*:\s*true/.test(provider),
    'the provider uses a shell-shaped process call; every managed run must be an argv array through ctx.subprocess',
  )
  assert.ok(
    !/\.\.\.process\.env/.test(provider),
    'the provider spreads process.env into a child, so the whitelist below is decoration',
  )

  const argvBlocks = [...provider.matchAll(/const argv = \[([\s\S]*?)\n {4}\]/g)].map(match => match[1])
  for (const block of argvBlocks) {
    assert.ok(block.includes("'--version'") === false, 'a spawnSync argv was parsed as a managed-run argv')
  }
  // The managed runs go through the service, which is what makes the argv array a guarantee
  // rather than a habit: the service takes an array by type.
  const spawnCalls = [...provider.matchAll(/\.spawn\(\{([\s\S]*?)\n {6}\}\)/g)].length
  assert.ok(spawnCalls >= 2, `the provider calls ctx.subprocess.spawn ${spawnCalls} times, fewer than the two managed paths`)

  // The child's environment is a literal, so it can be read off the source. Every key that is
  // not on this list is a value that does not reach Blender — which is how the DeepSeek API
  // key stays out of it (SPEC §15.5).
  const ALLOWED = ['PATH', 'HOME', 'TMPDIR', 'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE', 'DEEPBLEND_JOB_ID']
  const envBlocks = [...provider.matchAll(/env: \{([\s\S]*?)\n {8}\},/g)].map(match => match[1])
  assert.ok(envBlocks.length >= 2, `the provider composes ${envBlocks.length} child environments, not the two this test describes`)

  const parsed = envBlocks.map((block) => {
    const keys = [...block.matchAll(/^\s*([A-Z_][A-Z0-9_]*)\s*:/gm)].map(match => match[1])
    assert.ok(keys.length > 0, 'a child environment parsed no keys, so this assertion would be vacuous')
    const extra = keys.filter(key => !ALLOWED.includes(key))
    assert.deepEqual(
      extra,
      [],
      `the child environment carries ${extra.join(', ')}, which is not on the whitelist — ` +
        'anything not listed there is a value that reaches Blender, and SPEC §15.5 says secrets must not',
    )
    return keys.slice().sort()
  })

  // BOTH SPAWN PATHS MUST WHITELIST THE SAME NAMES. The subset check above lets one path carry fewer keys than
  // the other without a word, and a child that is missing `DEEPBLEND_JOB_ID` is a child whose correlation id is
  // absent — a behavioural difference between "start a render" and "resume one" that nothing else would notice.
  for (const keys of parsed.slice(1)) {
    assert.deepEqual(
      keys,
      parsed[0],
      'the two spawn paths whitelist different environments; a value that reaches one Blender does not reach the other',
    )
  }

  // AND THE DOCUMENTED LIST IS THE SAME LIST. `docs/security.md` names the variables (the canonical copy), and
  // `SECURITY.md` used to state a COUNT — "a five-variable whitelist" — while the code whitelisted six. A count
  // is the part of a sentence that rots, so the top-level file points at the list instead, and this check holds
  // the list itself against the code.
  const securityDoc = readFileSync(join(ROOT, 'deepblend', 'docs', 'security.md'), 'utf8')
  const documented = /环境只有\s*([A-Z_/]+)/.exec(securityDoc)?.[1]?.split('/').sort()
  assert.deepEqual(
    documented,
    ALLOWED.slice().sort(),
    'the whitelist in docs/security.md and the child environment in the provider are not the same set',
  )
  const topLevel = readFileSync(join(ROOT, 'SECURITY.md'), 'utf8')
  assert.ok(
    !/\b(?:five|six|seven|5|6|7)[- ]variable/i.test(topLevel) && !/[五六七八]\s*个变量/.test(topLevel),
    'SECURITY.md states how many variables the whitelist has; the list is the fact, and a count is what rots',
  )
})
