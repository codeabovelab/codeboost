import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const proxyScript = new URL('../agents/network/proxy.mjs', import.meta.url).pathname;
const children: ChildProcess[] = [];
const servers: Server[] = [];

const freePort = () => new Promise<number>(resolve => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    server.close(() => resolve(port));
  });
});
const waitForListen = async (port: number) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const open = await new Promise<boolean>(resolve => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Proxy did not start listening.');
};

async function startProxy() {
  const received: Buffer[] = [];
  const upstream = createServer(socket => socket.on('data', (chunk: Buffer) => received.push(chunk)));
  servers.push(upstream);
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port, proxyPort = await freePort();
  // Delay outbound connects in the proxy process, so the gap between parsing CONNECT and reaching the
  // upstream is reliably wide.
  const slowConnect = 'data:text/javascript,import net from "node:net";const connect=net.Socket.prototype.connect;'
    + 'net.Socket.prototype.connect=function(...args){setTimeout(()=>connect.apply(this,args),300);return this;};';
  const child = spawn(process.execPath, ['--import', slowConnect, proxyScript], { stdio: 'ignore', env: {
    CODEBOOST_ALLOWED_HOSTS: 'localhost', CODEBOOST_PROXY_PORT: String(proxyPort),
    CODEBOOST_UPSTREAM_PORT: String(upstreamPort) } });
  children.push(child);
  await waitForListen(proxyPort);
  return { proxyPort, upstreamPort, received: () => Buffer.concat(received).toString('utf8') };
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const server of servers.splice(0)) server.close();
});

describe('vendor egress proxy', () => {
  it('forwards bytes a client sends after CONNECT but before the tunnel is established', async () => {
    const { proxyPort, upstreamPort, received } = await startProxy();
    const client = connect(proxyPort, '127.0.0.1');
    await new Promise(resolve => client.once('connect', resolve));
    // Two writes: the header, then payload the client sends without waiting for the 200 response.
    client.write(`CONNECT localhost:${upstreamPort} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    // Long enough to arrive as a separate read, well before the delayed upstream connect completes.
    await new Promise(resolve => setTimeout(resolve, 100));
    client.write('early-client-hello');
    const deadline = Date.now() + 3_000;
    while (!received().includes('early-client-hello') && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    client.destroy();
    expect(received()).toContain('early-client-hello');
  });

  it('forwards a large payload that arrives in the same read as the CONNECT header', async () => {
    const { proxyPort, upstreamPort, received } = await startProxy();
    const client = connect(proxyPort, '127.0.0.1');
    await new Promise(resolve => client.once('connect', resolve));
    const payload = `large-hello-${'x'.repeat(16 * 1024)}`;
    client.write(`CONNECT localhost:${upstreamPort} HTTP/1.1\r\nHost: localhost\r\n\r\n${payload}`);
    const deadline = Date.now() + 3_000;
    while (received().length < payload.length && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    client.destroy();
    expect(received()).toBe(payload);
  });

  it('refuses a CONNECT header larger than 8 KiB', async () => {
    const { proxyPort, upstreamPort } = await startProxy();
    const client = connect(proxyPort, '127.0.0.1');
    let response = '';
    client.on('data', chunk => { response += chunk.toString('utf8'); });
    const closed = new Promise(resolve => client.once('close', resolve));
    client.write(`CONNECT localhost:${upstreamPort} HTTP/1.1\r\nX-Pad: ${'p'.repeat(9 * 1024)}\r\n\r\n`);
    await closed;
    expect(response).toMatch(/^HTTP\/1\.1 431 /);
  });

  it('refuses a streamed unterminated header without buffering it, and keeps serving', async () => {
    const { proxyPort, upstreamPort, received } = await startProxy();
    const flood = connect(proxyPort, '127.0.0.1');
    let response = '';
    flood.on('data', chunk => { response += chunk.toString('utf8'); });
    flood.on('error', () => undefined);
    const closed = new Promise(resolve => flood.once('close', resolve));
    flood.write(`CONNECT localhost:${upstreamPort} HTTP/1.1\r\nX-Pad: ${'p'.repeat(1024 * 1024)}`);
    await closed;
    expect(response).toMatch(/^HTTP\/1\.1 431 /);
    const client = connect(proxyPort, '127.0.0.1');
    await new Promise(resolve => client.once('connect', resolve));
    client.write(`CONNECT localhost:${upstreamPort} HTTP/1.1\r\n\r\nstill-serving`);
    const deadline = Date.now() + 3_000;
    while (!received().includes('still-serving') && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    client.destroy();
    expect(received()).toContain('still-serving');
  });

  it('refuses hosts outside the vendor allowlist', async () => {
    const { proxyPort, upstreamPort } = await startProxy();
    const client = connect(proxyPort, '127.0.0.1');
    let response = '';
    client.on('data', chunk => { response += chunk.toString('utf8'); });
    const closed = new Promise(resolve => client.once('close', resolve));
    client.write(`CONNECT example.com:${upstreamPort} HTTP/1.1\r\n\r\n`);
    await closed;
    expect(response).toMatch(/^HTTP\/1\.1 403 Forbidden/);
  });
});
