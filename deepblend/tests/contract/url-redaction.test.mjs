#!/usr/bin/env node
/**
 * What a URL looks like after this product has quoted it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * SPEC §15.2's "日志脱敏" was half done and the deviation table said so: no secret reaches a child
 * process, but nothing filtered what the plugin itself wrote — and what it wrote, in five places, was
 * the asset URL verbatim, into messages the MODEL reads and into job records an OPERATOR reads. A
 * presigned URL (`…?X-Amz-Signature=…`) is the ordinary way a model is handed a model file, so the
 * raw URL is a credential in the common case rather than in the exotic one.
 *
 * The assertions are about the two halves of that sentence: the secret parts are GONE, and the fact
 * that they were removed is VISIBLE. The second half is not decoration — a reader comparing a message
 * with what they pasted has to be able to tell a cleaned URL from one that never had a query, because
 * a retry against the cleaned one is a different request.
 *
 * Run standalone: `node deepblend/tests/contract/url-redaction.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { redactUrl } from '@deepblend/dsh-blender-contracts'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

check('a URL with no secret parts is quoted as it is, minus nothing',
  redactUrl('https://cdn.example.com/models/watch.glb') === 'https://cdn.example.com/models/watch.glb' &&
  redactUrl('http://127.0.0.1:8080/a.glb') === 'http://127.0.0.1:8080/a.glb',
  [redactUrl('https://cdn.example.com/models/watch.glb'), redactUrl('http://127.0.0.1:8080/a.glb')])

check('a presigned query is DROPPED, and the message says a query was dropped',
  redactUrl('https://bucket.s3.amazonaws.com/watch.glb?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA') ===
    'https://bucket.s3.amazonaws.com/watch.glb (query removed)' &&
  !redactUrl('https://bucket.s3.amazonaws.com/watch.glb?token=secret').includes('secret'),
  redactUrl('https://bucket.s3.amazonaws.com/watch.glb?X-Amz-Signature=deadbeef'))

check('credentials in the authority are dropped, and named',
  redactUrl('https://user:pa55w0rd@cdn.example.com/a.glb') === 'https://cdn.example.com/a.glb (credentials removed)' &&
  !redactUrl('https://user:pa55w0rd@cdn.example.com/a.glb').includes('pa55w0rd'),
  redactUrl('https://user:pa55w0rd@cdn.example.com/a.glb'))

check('a fragment is dropped too, and a URL with several secret parts names all of them',
  redactUrl('https://cdn.example.com/a.glb#section') === 'https://cdn.example.com/a.glb (fragment removed)' &&
  redactUrl('https://u:p@cdn.example.com/a.glb?k=v#f') ===
    'https://cdn.example.com/a.glb (credentials and query and fragment removed)',
  redactUrl('https://u:p@cdn.example.com/a.glb?k=v#f'))

check('the PATH survives, because that is what identifies the file',
  redactUrl('https://cdn.example.com/a/b/c%20d/watch.glb?token=x').startsWith('https://cdn.example.com/a/b/c%20d/watch.glb'),
  redactUrl('https://cdn.example.com/a/b/c%20d/watch.glb?token=x'))

check('a string that is not a URL cannot be cleaned, so it is BOUNDED instead',
  redactUrl('not a url at all') === 'not a url at all' &&
  redactUrl('x'.repeat(400)).length === 121 && redactUrl('x'.repeat(400)).endsWith('…'),
  { short: redactUrl('not a url at all'), longLength: redactUrl('x'.repeat(400)).length })

check('a non-string source is stringified rather than thrown at',
  redactUrl(undefined) === 'undefined' && redactUrl(null) === 'null' && redactUrl(42) === '42',
  [redactUrl(undefined), redactUrl(null), redactUrl(42)])

const passed = results.filter(entry => entry.ok).length
console.log(`\nURL redaction: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
