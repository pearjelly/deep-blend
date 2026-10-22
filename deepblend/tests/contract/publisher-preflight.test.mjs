/** Offline publication boundaries: real child timeout, HTTP stalls, and the actual CLI gate. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from '../../tools/workspace-layout.mjs'
import { npmError, packages, servedByRegistry, waitForRegistry } from '../../tools/publish-packages.mjs'

const tool = join(ROOT, 'deepblend/tools/publish-packages.mjs')
const moduleUrl = pathToFileURL(tool).href
const secret = 'npm_FAKEcredentialNeverPrint123456789'
const rejected = code => ({ status: 1, stdout: JSON.stringify({ error: { code, summary: `failure ${secret}` } }),
  stderr: `npm error code ${code}\nnpm error ${secret}` })

function harness(t, scenario, { program, args = [] } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'deepblend-publisher-boundary-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const receipt = join(scratch, 'calls.jsonl'), preload = join(scratch, 'preload.mjs')
  writeFileSync(preload, `
    import child from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { appendFileSync } from 'node:fs';
    const originalSpawn = child.spawnSync;
    const scenario = ${JSON.stringify(scenario)};
    const versions = ${JSON.stringify(Object.fromEntries(packages().map(entry => [entry.name, entry.version])))};
    const record = value => appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(value)+'\\n');
    child.spawnSync = (command, args, options) => {
      record({command,args,timeout:options?.timeout,killSignal:options?.killSignal,maxBuffer:options?.maxBuffer});
      if(command==='git' && args.join(' ')==='status --porcelain') return {status:0,stdout:'',stderr:''};
      if(command!=='npm') throw Error('Unexpected command');
      if(args[0]==='whoami' || args[0]==='profile') {
        if(scenario.hang) return originalSpawn(process.execPath,
          ['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], options);
        return scenario.identity ?? {status:0,stdout:JSON.stringify('verified-user'),stderr:''};
      }
      if(args[0]==='publish' && (scenario.allowPublish || args.includes('--dry-run'))) {
        return {status:0,stdout:'npm notice total files: 1\\nnpm notice package size: 1 kB',stderr:''};
      }
      throw Error('Unexpected npm write');
    };
    syncBuiltinESMExports();
    let reads=0;
    globalThis.fetch=async (url, options) => {
      record({registryRead:true,hasSignal:options?.signal instanceof AbortSignal});
      const outcome=scenario.reads?.[reads++] ?? scenario.registry ?? 'forbidden';
      if(outcome==='forbidden') throw Error('Unexpected registry read');
      if(outcome==='unknown') throw Error('registry unavailable');
      if(outcome==='absent') return new Response('{}', {status:404});
      const name=decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).join('/'));
      return Response.json({versions:{[versions[name]]:{}}});
    };
    if(scenario.fastPoll) { let now=0; Date.now=()=>now+=300000; }
  `)
  const command = ['--import', pathToFileURL(preload).href, ...(program
    ? ['--input-type=module', '-e', program] : [tool, ...args])]
  const result = spawnSync(process.execPath, command, { cwd: ROOT, encoding: 'utf8', timeout: 6_000 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  let calls = []
  try { calls = readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line)) } catch {}
  return { ...result, output, calls }
}

test('identity reads distinguish verified, rejected and unknown without exposing raw output', t => {
  const cases = [
    [{ status: 0, stdout: '"verified-user"', stderr: `npm warn ${secret}` }, { status: 'verified', username: 'verified-user' }],
    ...['ENEEDAUTH', 'E401', 'E403'].map(code => [rejected(code), { status: 'rejected', code }]),
    [rejected('E500'), { status: 'unknown', reason: 'registry' }],
    [rejected('ECONNRESET'), { status: 'unknown', reason: 'network' }],
    [{ status: 1, stdout: JSON.stringify({ error: { code: 'FETCH_ERROR',
      summary: 'network timeout at: https://registry.npmjs.org/-/whoami', detail: '' } }) },
    { status: 'unknown', reason: 'network' }],
    [rejected('ETIMEDOUT'), { status: 'unknown', reason: 'timeout' }],
    [{ status: 0, stdout: secret }, { status: 'unknown', reason: 'response' }],
    [{ status: 0, stdout: JSON.stringify(secret) }, { status: 'unknown', reason: 'response' }],
    [{ status: null, error: { code: 'ENOENT' } }, { status: 'unknown', reason: 'command' }],
    [{ status: 1, stdout: '', stderr: 'npm ERR! code E403' }, { status: 'rejected', code: 'E403' }],
  ]
  for (const [identity, expected] of cases) {
    const result = harness(t, { identity }, { program:
      `const m=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(m.npmIdentity()));` })
    assert.equal(result.status, 0, result.output)
    assert.deepEqual(JSON.parse(result.stdout), expected)
    assert.ok(!result.output.includes(secret), 'raw identity diagnostic leaked')
    assert.equal(result.calls.length, 1)
    const [call] = result.calls
    assert.ok(call.args.includes('--fetch-retries=0'))
    assert.ok(call.args.includes('--fetch-timeout=10000'))
    assert.equal(call.timeout, 15_000)
    assert.equal(call.killSignal, 'SIGKILL')
    assert.equal(call.maxBuffer, 64 * 1024)
  }
})

test('a stuck npm identity or profile subprocess is actually killed within the read deadline', t => {
  const result = harness(t, { hang: true }, { program: `
    const m=await import(${JSON.stringify(moduleUrl)});
    const start=performance.now();
    console.log(JSON.stringify({identity:m.npmIdentity({timeoutMs:80}),
      profile:m.twoFactorEnabled({timeoutMs:80}),elapsed:performance.now()-start}));
  ` })
  assert.equal(result.status, 0, result.output)
  const outcome = JSON.parse(result.stdout)
  assert.deepEqual(outcome.identity, { status: 'unknown', reason: 'timeout' })
  assert.equal(outcome.profile, null)
  assert.ok(outcome.elapsed < 2000, `read deadline did not bound the subprocess: ${outcome.elapsed}ms`)
  assert.equal(result.calls.length, 2)
  assert.ok(result.calls.every(call => call.timeout === 80 && call.killSignal === 'SIGKILL'))
})

test('CLI identity gate stops before writes and never turns an unknown read into login advice', t => {
  for (const [code, args] of [['E500', []], ['ECONNRESET', []], ['FETCH_ERROR', []], ['ETIMEDOUT', []], ['E500', ['--check']], ['E401', []], ['E403', []]]) {
    const result = harness(t, { identity: rejected(code) }, { args })
    assert.equal(result.status, 2, result.output)
    assert.ok(!result.output.includes(secret))
    assert.ok(!result.calls.some(call => call.registryRead))
    assert.ok(!result.calls.some(call => call.args?.[0] === 'publish' && !call.args.includes('--dry-run')))
    if (['E401', 'E403'].includes(code)) {
      assert.match(result.output, /npm rejected the identity check/)
    } else {
      assert.match(result.output, /npm identity could not be verified/)
      assert.match(result.output, /retry the identity check later/)
      assert.doesNotMatch(result.output, /npm login|not logged in|regenerate|--otp/)
    }
  }
})

test('registry evidence distinguishes absent versions from unavailable or invalid responses', async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const [response, expected] of [
      [() => Response.json({ versions: { '1.2.3': {} } }), true],
      [() => Response.json({ versions: {} }), false],
      [() => new Response('{}', { status: 404 }), false],
      [() => new Response('{}', { status: 500 }), null],
      [() => new Response('{}', { status: 403 }), null],
      [() => new Response('not json'), null],
      [() => Response.json({}), null],
      [() => { throw Error(secret) }, null],
    ]) {
      globalThis.fetch = async (_url, options) => {
        assert.ok(options.signal instanceof AbortSignal)
        return response()
      }
      assert.equal(await servedByRegistry('@deepblend/test', '1.2.3'), expected)
    }
  } finally { globalThis.fetch = originalFetch }
})

test('registry requests and body reads terminate when an actual HTTP response stalls', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"versions":') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const originalFetch = globalThis.fetch
  try {
    for (const mode of ['headers', 'body']) {
      globalThis.fetch = (_url, options) => originalFetch(`http://127.0.0.1:${server.address().port}/${mode}`, options)
      const start = performance.now()
      assert.equal(await servedByRegistry('@deepblend/test', '1.2.3', { timeoutMs: 50 }), null)
      assert.equal(await waitForRegistry('@deepblend/test', '1.2.3', {
        timeoutMs: 20, intervalMs: 1, requestTimeoutMs: 30,
      }), null)
      assert.ok(performance.now() - start < 1500, 'registry read exceeded its bounded attempts')
    }
  } finally { globalThis.fetch = originalFetch }
})

test('the publisher never reports unverified registry results as a fully read-back release', t => {
  const count = packages().length
  for (const [lastRead, expectedCode] of [['unknown', 1], ['absent', 1], ['present', 0]]) {
    const result = harness(t, { allowPublish: true, fastPoll: true,
      reads: [...Array(count).fill('present'), lastRead], registry: 'present' })
    assert.equal(result.status, expectedCode, result.output)
    assert.equal(result.calls.filter(call => call.args?.[0] === 'whoami').length, 1, 'default identity preflight was skipped')
    assert.equal(result.calls.filter(call => call.args?.[0] === 'publish').length, count, 'a write was retried')
    if (lastRead === 'unknown') {
      assert.match(result.output, /1 package\(s\) remain UNVERIFIED/)
      assert.match(result.output, /read these versions again before retrying any publish/)
      assert.doesNotMatch(result.output, /all 7 packages are on the registry|npm login|not logged in/)
    } else if (lastRead === 'absent') {
      assert.match(result.output, /1 package\(s\) are NOT on the registry/)
      assert.doesNotMatch(result.output, /all 7 packages are on the registry/)
    } else {
      assert.match(result.output, /all 7 packages are on the registry, each one read back/)
    }
    assert.ok(result.calls.filter(call => call.registryRead).every(call => call.hasSignal))
  }
})

test('publish error summaries redact credential-shaped data without reading npm configuration', () => {
  const output = npmError(`npm error Failure ${secret} Authorization: Bearer PRIVATE_AUTH _authToken=PRIVATE_TOKEN https://name:PRIVATE_URL@registry.npmjs.org/ --otp=123456`)
  assert.match(output, /Failure/)
  for (const forbidden of [secret, 'PRIVATE_AUTH', 'PRIVATE_TOKEN', 'PRIVATE_URL', '123456']) {
    assert.ok(!output.includes(forbidden), 'credential-shaped error content leaked')
  }
})
