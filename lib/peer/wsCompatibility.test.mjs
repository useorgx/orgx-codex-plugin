import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket, { Receiver, WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const { version } = require('ws/package.json');
// Intentional upstream differences, not compatibility failures. Keep this
// matrix explicit so a later dependency update requires reviewing its limits.
const expectations = {
  '8.21.0': { fragments: 131_072, bufferedChunks: 1_048_576, countEmpty: false },
  '8.22.0': { fragments: 16_384, bufferedChunks: 262_144, countEmpty: true },
}[version];
assert.ok(expectations, `review WebSocket compatibility expectations for ws ${version}`);

async function localPair(t, options = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
  let client;
  t.after(async () => {
    client?.terminate();
    for (const peer of server.clients) peer.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  await once(server, 'listening');
  const connection = once(server, 'connection');
  // This is the same overload used by peer.mjs; no optional client overrides.
  client = new WebSocket(`ws://127.0.0.1:${server.address().port}`, ['orgx.v3', 'synthetic-test']);
  const errors = [];
  client.on('error', (error) => errors.push(error));
  const upgrade = once(client, 'upgrade');
  const [[peer, request], , [response]] = await Promise.all([connection, once(client, 'open'), upgrade]);
  assert.equal(client.protocol, 'orgx.v3');
  assert.equal(request.headers['sec-websocket-protocol'], 'orgx.v3,synthetic-test');
  return { client, peer, response, errors };
}

// Minimal RFC 6455 server frames. These fixtures are unmasked because the
// receiving side is a client; framing does not depend on ws's Sender code.
function frame(opcode, payload = Buffer.alloc(0), fin = true) {
  assert.ok(payload.length <= 125);
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, payload.length]), payload]);
}

function fragmentedText(count, empty = false) {
  const width = empty ? 2 : 3;
  const frames = Buffer.alloc(count * width);
  for (let index = 0; index < count; index += 1) {
    const offset = index * width;
    frames[offset] = (index === 0 ? 1 : 0) | (index === count - 1 ? 0x80 : 0);
    frames[offset + 1] = empty ? 0 : 1;
    if (!empty) frames[offset + 2] = 0x61;
  }
  return frames;
}

async function write(receiver, data) {
  return new Promise((resolve, reject) => receiver.write(data, (error) => error ? reject(error) : resolve()));
}

test('the peer constructor keeps subprotocols and fragmented JSON with empty/control frames', { timeout: 10_000 }, async (t) => {
  const { client, peer, errors } = await localPair(t);
  const payload = { kind: 'task.dispatch', run_id: 'synthetic-fragments', task: { title: 'local only' } };
  const text = JSON.stringify(payload);
  const middle = Math.floor(text.length / 2);
  const received = once(client, 'message');
  const ping = once(client, 'ping');
  peer._socket.write(Buffer.concat([
    frame(1, Buffer.from(text.slice(0, middle)), false),
    frame(0, Buffer.alloc(0), false),
    frame(9, Buffer.from('alive')),
    frame(0, Buffer.from(text.slice(middle))),
  ]));
  const [[data, binary], [pingData]] = await Promise.all([received, ping]);
  assert.deepEqual(JSON.parse(data.toString()), payload);
  assert.equal(binary, false);
  assert.equal(pingData.toString(), 'alive');
  const next = once(client, 'message');
  peer._socket.write(frame(1, Buffer.from('{"kind":"next"}')));
  assert.deepEqual(JSON.parse((await next)[0].toString()), { kind: 'next' });
  assert.deepEqual(errors, []);
});

test(`ws ${version} applies its documented client defaults`, { timeout: 10_000 }, async (t) => {
  const { client } = await localPair(t);
  // Internal inspection is limited to verifying that the two-argument factory
  // receives the expected defaults; the following tests exercise their effects.
  assert.equal(client._receiver._maxFragments, expectations.fragments);
  assert.equal(client._receiver._maxBufferedChunks, expectations.bufferedChunks);
  assert.equal(client._receiver._maxPayload, 100 * 1024 * 1024);
});

test(`ws ${version} accepts its default fragment limit and resets it per message`, { timeout: 10_000 }, async (t) => {
  const { client, peer, errors } = await localPair(t);
  const received = once(client, 'message');
  peer._socket.write(fragmentedText(expectations.fragments));
  const [data, binary] = await received;
  assert.equal(data.length, expectations.fragments);
  assert.equal(data.toString(), 'a'.repeat(expectations.fragments));
  assert.equal(binary, false);
  const next = once(client, 'message');
  peer._socket.write(fragmentedText(2));
  assert.equal((await next)[0].toString(), 'aa');
  assert.deepEqual(errors, []);
});

test(`ws ${version} rejects one frame above its default fragment limit`, { timeout: 10_000 }, async (t) => {
  const { client, peer } = await localPair(t);
  let delivered = false;
  client.on('message', () => { delivered = true; });
  const failure = once(client, 'error');
  peer._socket.write(fragmentedText(expectations.fragments + 1));
  const [error] = await failure;
  assert.equal(error.code, 'WS_ERR_TOO_MANY_BUFFERED_PARTS');
  assert.match(error.message, /Too many message fragments/);
  assert.equal(delivered, false);
});

test(`ws ${version} empty-fragment counting matches the intentional version change`, async (t) => {
  const receiver = new Receiver({ maxFragments: 4 });
  receiver.on('error', () => {});
  t.after(() => receiver.destroy());
  const messages = [];
  receiver.on('message', (data) => messages.push(data.toString()));
  await write(receiver, fragmentedText(4, true));
  assert.deepEqual(messages, ['']);
  if (expectations.countEmpty) {
    await assert.rejects(write(receiver, fragmentedText(5, true)), { code: 'WS_ERR_TOO_MANY_BUFFERED_PARTS' });
    assert.deepEqual(messages, ['']);
  } else {
    await write(receiver, fragmentedText(5, true));
    assert.deepEqual(messages, ['', '']);
  }
});

test('control frames do not consume a message fragment allowance', async (t) => {
  const receiver = new Receiver({ maxFragments: 2 });
  receiver.on('error', () => {});
  t.after(() => receiver.destroy());
  const received = once(receiver, 'message');
  await write(receiver, Buffer.concat([
    frame(1, Buffer.from('a'), false),
    frame(9, Buffer.from('ping')),
    frame(10, Buffer.from('pong')),
    frame(0, Buffer.from('b')),
  ]));
  assert.equal((await received)[0].toString(), 'ab');
});

test(`ws ${version} accepts its default buffered chunk count and rejects the next chunk`, { timeout: 10_000 }, async (t) => {
  // TCP may coalesce socket writes, so feed the exported Receiver deterministic
  // chunks at the constructor's verified default. Reuse one buffer throughout.
  const receiver = new Receiver({ maxBufferedChunks: expectations.bufferedChunks, maxPayload: 100 * 1024 * 1024 });
  t.after(() => receiver.destroy());
  const errors = [];
  receiver.on('error', (error) => errors.push(error));
  let delivered = false;
  receiver.on('message', () => { delivered = true; });
  const header = Buffer.alloc(10);
  header[0] = 0x82;
  header[1] = 127;
  header.writeBigUInt64BE(16n * 1024n * 1024n, 2);
  await write(receiver, header);
  const byte = Buffer.from('a');
  for (let count = 0; count < expectations.bufferedChunks; count += 1) receiver.write(byte);
  await nextTurn();
  assert.deepEqual(errors, []);
  assert.equal(delivered, false, 'an incomplete payload must not be delivered');
  const failure = once(receiver, 'error');
  receiver.write(byte);
  const [error] = await failure;
  assert.equal(error.code, 'WS_ERR_TOO_MANY_BUFFERED_PARTS');
  assert.match(error.message, /Too many buffered chunks/);
  assert.equal(delivered, false);
});

test('a complete frame at the buffered chunk boundary is delivered and releases the allowance', async (t) => {
  const receiver = new Receiver({ maxBufferedChunks: 4 });
  receiver.on('error', () => {});
  t.after(() => receiver.destroy());
  const messages = [];
  receiver.on('message', (data) => messages.push(data.toString()));
  for (let repetition = 0; repetition < 2; repetition += 1) {
    await write(receiver, Buffer.from([0x81, 4]));
    for (const character of 'abcd') await write(receiver, Buffer.from(character));
  }
  assert.deepEqual(messages, ['abcd', 'abcd']);
});

test('default compression negotiation reassembles fragmented compressed JSON and following messages', { timeout: 10_000 }, async (t) => {
  const { client, peer, response, errors } = await localPair(t, {
    perMessageDeflate: { clientMaxWindowBits: 10, serverMaxWindowBits: 10, threshold: 0 },
  });
  assert.equal(client.extensions, 'permessage-deflate');
  assert.equal(peer.extensions, 'permessage-deflate');
  assert.match(response.headers['sec-websocket-extensions'], /client_max_window_bits=10/);
  assert.match(response.headers['sec-websocket-extensions'], /server_max_window_bits=10/);
  const payload = { kind: 'task.dispatch', run_id: 'synthetic-compressed', task: { title: 'fragmented '.repeat(100) } };
  const text = JSON.stringify(payload);
  const middle = Math.floor(text.length / 2);
  const received = once(client, 'message');
  peer.send(text.slice(0, middle), { fin: false, compress: true });
  peer.send('', { fin: false, compress: true });
  peer.send(text.slice(middle), { fin: true, compress: true });
  assert.deepEqual(JSON.parse((await received)[0].toString()), payload);
  const next = once(client, 'message');
  peer.send(JSON.stringify({ kind: 'next' }), { compress: true });
  assert.deepEqual(JSON.parse((await next)[0].toString()), { kind: 'next' });
  const returned = once(peer, 'message');
  client.send(JSON.stringify({ kind: 'task.receipt', run_id: payload.run_id }));
  assert.deepEqual(JSON.parse((await returned)[0].toString()), { kind: 'task.receipt', run_id: payload.run_id });
  assert.deepEqual(errors, []);
});
