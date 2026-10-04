/** Fault-injected CDP transport. No Chrome, DSH, Blender or user profile required. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser, BrowserPage } from '../../tools/browser-driver.mjs'

/** A tiny local WebSocket peer: real transport with deliberately missing/bad CDP responses. */
async function fixture(t, handler = () => false, options = {}) {
  const sockets = new Set(), commands = []
  const server = createServer()
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}) })
  server.on('upgrade', (request, socket) => {
    if (options.handshake === 'silent') return
    if (options.handshake === 'close') { socket.destroy(); return }
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const emit = value => {
      const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(bytes.length < 126 ? 2 : 4)
      header[0] = 0x81; header[1] = bytes.length < 126 ? bytes.length : 126
      if (bytes.length >= 126) header.writeUInt16BE(bytes.length, 2)
      socket.write(Buffer.concat([header, bytes]))
    }
    const peer = { reply: (command, result = {}) => emit({ id: command.id, result }),
      reject: (command, message) => emit({ id: command.id, error: { code: -32000, message } }),
      event: (method, params = {}) => emit({ method, params }), close: () => socket.end(Buffer.from([0x88, 0])) }
    let buffered = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk])
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15, masked = Boolean(buffered[1] & 128)
        let length = buffered[1] & 127, offset = 2
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4 }
        assert.notEqual(length, 127, 'fault fixture messages stay below 64 KiB')
        if (buffered.length < offset + (masked ? 4 : 0) + length) return
        const mask = masked ? buffered.subarray(offset, offset + 4) : null; offset += masked ? 4 : 0
        const bytes = Buffer.from(buffered.subarray(offset, offset + length)); buffered = buffered.subarray(offset + length)
        if (mask) for (let i = 0; i < bytes.length; i++) bytes[i] ^= mask[i % 4]
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return }
        if (opcode !== 1) continue
        const command = JSON.parse(bytes); commands.push(command)
        if (!handler(command, peer)) peer.reply(command)
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const page = new BrowserPage(`ws://127.0.0.1:${server.address().port}/test-page`, undefined,
    { commandTimeoutMs: 100, connectTimeoutMs: 500, closeTimeoutMs: 40, ...options.timeouts })
  t.after(async () => { await page.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) })
  return { page, commands, connect: () => page.connect() }
}

const clean = page => { assert.equal(page._pending.size, 0); assert.equal(page._eventWaiters.size, 0) }

test('a silent command rejects once, clears its timer, ignores a late reply and still permits evidence reads', { timeout: 3000 }, async t => {
  let late
  const f = await fixture(t, (command, peer) => {
    if (command.method === 'Input.dispatchMouseEvent') { late = () => peer.reply(command); return true }
    if (command.method === 'Runtime.evaluate') { peer.reply(command, { result: { value: 'evidence available' } }); return true }
  })
  await f.connect()
  await assert.rejects(f.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased' }), error => {
    assert.equal(error.code, 'CDP_COMMAND_TIMEOUT'); assert.equal(error.method, 'Input.dispatchMouseEvent')
    assert.equal(error.timeoutMs, 100); assert.match(error.message, /not retried/); return true
  })
  clean(f.page); late()
  assert.equal(await f.page.evaluate('document.body.innerText'), 'evidence available')
  assert.equal(f.commands.filter(command => command.method === 'Input.dispatchMouseEvent').length, 1); clean(f.page)
})

test('protocol rejection retains the server error and leaves no pending command', async t => {
  const f = await fixture(t, (command, peer) => { if (command.method === 'DOM.getDocument') { peer.reject(command, 'injected refusal'); return true } })
  await f.connect()
  await assert.rejects(f.page.send('DOM.getDocument'), error => error.code === 'CDP_PROTOCOL_ERROR' && /injected refusal/.test(error.message))
  clean(f.page); assert.equal(f.commands.filter(command => command.method === 'DOM.getDocument').length, 1)
})

test('a synchronous socket send failure clears pending work and preserves the cause', async t => {
  const f = await fixture(t); await f.connect()
  const mock = t.mock.method(f.page._socket, 'send', () => { throw new Error('injected send failure') })
  await assert.rejects(f.page.send('DOM.getDocument'), error => error.code === 'CDP_SEND_FAILED' && error.cause.message === 'injected send failure')
  clean(f.page); mock.mock.restore(); await f.page.send('DOM.getDocument'); clean(f.page)
})

test('socket disconnect immediately rejects all commands and a navigation waiter; new work is refused', { timeout: 3000 }, async t => {
  let disconnect
  const f = await fixture(t, (command, peer) => {
    if (['Runtime.evaluate', 'Page.captureScreenshot', 'Page.navigate'].includes(command.method)) { disconnect = peer.close; return true }
  })
  await f.connect()
  const pending = Promise.allSettled([f.page.evaluate('1'), f.page.send('Page.captureScreenshot'), f.page.goto('http://example.invalid')])
  while (!disconnect) await new Promise(resolve => setTimeout(resolve, 1))
  disconnect()
  const results = await pending
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'CDP_SOCKET_CLOSED'),
    JSON.stringify(results.map(result => ({ status: result.status, code: result.reason?.code, message: result.reason?.message }))))
  clean(f.page)
  const count = f.commands.length; await assert.rejects(f.page.send('DOM.getDocument'), { code: 'CDP_SOCKET_CLOSED' })
  assert.equal(f.commands.length, count)
})

test('socket error rejects outstanding work even when no close event follows', async t => {
  const f = await fixture(t, command => command.method === 'Runtime.evaluate'); await f.connect()
  const checked = assert.rejects(f.page.evaluate('1'), { code: 'CDP_SOCKET_ERROR' })
  f.page._socket.dispatchEvent(new Event('error'))
  await checked; clean(f.page)
  await assert.rejects(f.page.send('DOM.getDocument'), { code: 'CDP_SOCKET_ERROR' })
})

test('close is bounded and idempotent when Page.close receives no reply; other work is rejected', { timeout: 3000 }, async t => {
  const f = await fixture(t, command => ['Runtime.evaluate', 'Page.close'].includes(command.method), { timeouts: { commandTimeoutMs: 1000 } })
  await f.connect()
  const checked = assert.rejects(f.page.evaluate('1'), { code: 'CDP_PAGE_CLOSED' })
  const first = f.page.close(); assert.equal(f.page.close(), first); await first; await checked
  clean(f.page); assert.equal(f.commands.filter(command => command.method === 'Page.close').length, 1)
  await assert.rejects(f.page.send('DOM.getDocument'), { code: 'CDP_PAGE_CLOSED' })
})

test('Chrome profile cleanup still runs if a page close fails', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'deepblend-driver-close-')); t.after(() => rmSync(directory, { recursive: true, force: true }))
  const signals = [], browser = new Browser({ kill: signal => signals.push(signal) }, 0, directory)
  browser.pages.push({ close: async () => { throw new Error('injected page close failure') } })
  await browser.close(); assert.deepEqual(signals, ['SIGKILL']); assert.equal(existsSync(directory), false)
})

test('a connection that never upgrades fails within its own deadline', { timeout: 3000 }, async t => {
  const f = await fixture(t, undefined, { handshake: 'silent', timeouts: { connectTimeoutMs: 60 } })
  await assert.rejects(f.connect(), { code: 'CDP_CONNECT_TIMEOUT' }); clean(f.page)
})

test('connection loss before open rejects instead of leaving connect pending', { timeout: 3000 }, async t => {
  const f = await fixture(t, undefined, { handshake: 'close' })
  await assert.rejects(f.connect(), error => ['CDP_SOCKET_ERROR', 'CDP_SOCKET_CLOSED'].includes(error.code)); clean(f.page)
})

test('a missing initialization response closes the connection and rejects pending work', { timeout: 3000 }, async t => {
  const f = await fixture(t, command => command.method === 'Runtime.enable')
  await assert.rejects(f.connect(), error => error.code === 'CDP_COMMAND_TIMEOUT' && error.method === 'Runtime.enable'); clean(f.page)
  await assert.rejects(f.page.send('DOM.getDocument'), { code: 'CDP_COMMAND_TIMEOUT' })
})

test('missing navigation load event expires and releases its waiter', { timeout: 3000 }, async t => {
  const f = await fixture(t); await f.connect()
  await assert.rejects(f.page.goto('http://example.invalid'), error => error.code === 'CDP_EVENT_TIMEOUT' && error.method === 'Page.loadEventFired')
  clean(f.page)
})

test('navigation preserves a reported network suspension without waiting or retrying', async t => {
  const f = await fixture(t, (command, peer) => {
    if (command.method === 'Page.navigate') { peer.reply(command, { errorText: 'net::ERR_NETWORK_IO_SUSPENDED' }); return true }
  })
  await f.connect()
  await assert.rejects(f.page.goto('http://example.invalid'), /net::ERR_NETWORK_IO_SUSPENDED/)
  clean(f.page); assert.equal(f.commands.filter(command => command.method === 'Page.navigate').length, 1)
})

test('navigation observes a load event sent before the navigate response', async t => {
  const f = await fixture(t, (command, peer) => {
    if (command.method === 'Page.navigate') { peer.event('Page.loadEventFired'); peer.reply(command); return true }
  })
  await f.connect(); assert.equal(await f.page.goto('http://example.invalid'), f.page); clean(f.page)
})

test('waitFor propagates a lost evaluation response immediately and does not retry it as a false condition', { timeout: 3000 }, async t => {
  const f = await fixture(t, command => command.method === 'Runtime.evaluate'); await f.connect()
  await assert.rejects(f.page.waitFor('true', 180000), error => error.code === 'CDP_COMMAND_TIMEOUT' && error.method === 'Runtime.evaluate')
  assert.equal(f.commands.filter(command => command.method === 'Runtime.evaluate').length, 1); clean(f.page)
})
