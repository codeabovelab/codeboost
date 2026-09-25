import { createServer, connect } from 'node:net';

const allowed = new Set((process.env.CODEBOOST_ALLOWED_HOSTS ?? '').split(',').filter(Boolean));
if (!allowed.size) throw new Error('CODEBOOST_ALLOWED_HOSTS is required.');
// Ports are fixed in production; the overrides exist so tests can run the proxy against a local upstream.
const listenPort = Number(process.env.CODEBOOST_PROXY_PORT ?? 3128);
const upstreamPort = Number(process.env.CODEBOOST_UPSTREAM_PORT ?? 443);
const connectLine = new RegExp(`^CONNECT ([a-z0-9.-]+):${upstreamPort} HTTP\\/1\\.[01]$`);

const refuse = (socket, status = '403 Forbidden') => {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
};

createServer(client => {
  client.setTimeout(300_000, () => client.destroy());
  let request = Buffer.alloc(0);
  const receive = chunk => {
    request = Buffer.concat([request, chunk], request.length + chunk.length);
    if (request.length > 8192) {
      client.off('data', receive);
      refuse(client, '431 Request Header Fields Too Large');
      return;
    }
    const boundary = request.indexOf('\r\n\r\n');
    if (boundary < 0) return;
    // Stop reading until the tunnel is piped, so bytes sent after CONNECT stay buffered instead of being dropped.
    client.off('data', receive);
    client.pause();
    const line = request.subarray(0, request.indexOf('\r\n')).toString('ascii');
    const host = connectLine.exec(line)?.[1];
    if (!host || !allowed.has(host)) {
      refuse(client);
      return;
    }
    let established = false;
    const upstream = connect({ host, port: upstreamPort });
    upstream.setTimeout(300_000, () => upstream.destroy());
    upstream.once('connect', () => {
      established = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const remainder = request.subarray(boundary + 4);
      if (remainder.length) upstream.write(remainder);
      client.pipe(upstream).pipe(client);
    });
    // Before the tunnel exists the client can still read an HTTP status; inside it, only a reset is safe.
    upstream.once('error', () => { if (established) client.destroy(); else refuse(client, '502 Bad Gateway'); });
    client.once('error', () => upstream.destroy());
    client.once('close', () => upstream.destroy());
  };
  client.on('data', receive);
  client.once('error', () => undefined);
}).listen(listenPort, '0.0.0.0');
