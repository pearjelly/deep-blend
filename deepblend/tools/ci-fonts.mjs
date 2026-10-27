/** Fetch the CJK font against authenticated APT metadata, with bounded official mirrors. */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGE = 'fonts-noto-cjk'
const VERSION = /^[0-9][A-Za-z0-9.+:~-]*$/
const FORMAT = '${db:Status-Status}\t${db:Status-Eflag}\t${Version}\n'
const MIRRORS = ['https://archive.ubuntu.com/ubuntu/', 'https://azure.archive.ubuntu.com/ubuntu/']
const TRANSPORT_FAILURES = new Set([5, 6, 7, 18, 28, 35, 52, 55, 56])
export function parseCiFontMetadata(text) {
  const fields = new Map()
  for (const line of text.trim().split('\n')) {
    const match = /^(Package|Version|Architecture|Filename|Size|SHA256): (.+)$/.exec(line)
    if (!match) continue
    if (fields.has(match[1])) throw new Error('Ambiguous CJK font metadata')
    fields.set(match[1], match[2])
  }
  const pin = Object.fromEntries(fields)
  if (pin.Package !== PACKAGE || !VERSION.test(pin.Version ?? '') || pin.Architecture !== 'all'
    || !/^pool\/main\/f\/fonts-noto-cjk\/fonts-noto-cjk_[A-Za-z0-9.+~%-]+_all\.deb$/.test(pin.Filename ?? '')
    || !/^[1-9][0-9]*$/.test(pin.Size ?? '') || !Number.isSafeInteger(Number(pin.Size))
    || !/^[a-f0-9]{64}$/.test(pin.SHA256 ?? '')) throw new Error('Invalid CJK font metadata')
  return pin
}
function verifyArchive(path, pin, execute) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size !== Number(pin.Size)) throw new Error('CJK font archive size/type differs')
  if (createHash('sha256').update(readFileSync(path)).digest('hex') !== pin.SHA256) throw new Error('CJK font archive SHA-256 differs')
  const identity = execute('dpkg-deb', ['--show', '--showformat=${Package}\t${Version}\t${Architecture}\n', path]).trimEnd()
  if (identity !== `${PACKAGE}\t${pin.Version}\tall`) throw new Error('CJK font archive identity differs')
}
function installedVersion(execute) {
  try {
    const fields = execute('dpkg-query', ['--show', `--showformat=${FORMAT}`, PACKAGE]).trimEnd().split('\t')
    if (fields.length === 3 && fields[0] === 'installed' && fields[1] === 'ok' && VERSION.test(fields[2])) return fields[2]
  } catch (error) { if (error.status !== 1) throw error }
  return null
}
export function withCiFont(execute, { cacheDirectory, reportDirectory } = {}, install) {
  const report = { schemaVersion: 'deepblend.ci-font/v2', package: PACKAGE, attempts: [], passed: false }
  try {
    const previous = installedVersion(execute)
    let argument = PACKAGE, pin
    report.previouslyInstalledVersion = previous
    if (!previous) {
      pin = parseCiFontMetadata(execute('apt-cache', ['show', '--no-all-versions', PACKAGE]))
      report.metadata = pin
      if (!cacheDirectory) throw new Error('CJK font cache directory required')
      mkdirSync(cacheDirectory, { recursive: true })
      argument = join(cacheDirectory, `${pin.SHA256}.deb`)
      report.cacheHit = Boolean(lstatSync(argument, { throwIfNoEntry: false }))
      if (report.cacheHit) verifyArchive(argument, pin, execute)
      else {
        const partial = `${argument}.partial-${process.pid}`
        try {
          for (const mirror of MIRRORS) {
            const attempt = { url: mirror + pin.Filename, downloaded: false }
            report.attempts.push(attempt)
            try {
              execute('curl', ['--fail', '--silent', '--show-error', '--proto', '=https',
                '--connect-timeout', '15', '--max-time', '120', '--speed-limit', '1024', '--speed-time', '30',
                '--output', partial, attempt.url])
              attempt.downloaded = true
            } catch (error) {
              attempt.exitCode = error.status ?? null
              rmSync(partial, { force: true })
              if (!TRANSPORT_FAILURES.has(error.status) || mirror === MIRRORS.at(-1)) throw error
              continue
            }
            verifyArchive(partial, pin, execute)
            renameSync(partial, argument)
            break
          }
        } finally { rmSync(partial, { force: true }) }
      }
    }
    // Prepare fontconfig and the other runner libraries without passing the font
    // to APT: APT can reacquire the same version from its remote index even when
    // given a local .deb. dpkg consumes only the archive verified immediately here.
    install()
    if (!previous) {
      verifyArchive(argument, pin, execute)
      const output = execute('sudo', ['dpkg', '--install', argument])
      report.installation = { method: 'verified-local-dpkg', archiveSha256: pin.SHA256,
        output, outputSha256: createHash('sha256').update(output).digest('hex') }
    } else report.installation = { method: 'already-installed' }
    report.installedVersion = installedVersion(execute)
    if (!report.installedVersion || report.installedVersion !== (pin?.Version ?? previous)) throw new Error('CJK font installation differs')
    report.matchedFamily = execute('fc-match', ['--format=%{family}\n', 'Noto Sans CJK SC:lang=zh-cn']).trim()
    if (!report.matchedFamily.split(',').some(name => name.trim() === 'Noto Sans CJK SC')) throw new Error('CJK font family unavailable')
    report.passed = true
    return report
  } catch (error) {
    report.failure = { message: error.message, exitCode: error.status ?? null, code: error.code ?? null }
    throw error
  } finally {
    if (reportDirectory) {
      mkdirSync(reportDirectory, { recursive: true })
      writeFileSync(join(reportDirectory, 'font-preparation.json'), JSON.stringify(report, null, 2) + '\n')
    }
  }
}
