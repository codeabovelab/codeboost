import { createServer, connect } from 'node:net';

const allowed = new Set((process.env.CODEBOOST_ALLOWED_HOSTS ?? '').split(',').filter(Boolean));
if (!allowed.size) throw new Error('CODEBOOST_ALLOWED_HOSTS is required.');

const refuse = (socket, status = '403 Forbidden') => {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
};

createServer(client => {
  client.setTimeout(300_000, () => client.destroy());
  let request = Buffer.alloc(0), settled = false;
  const receive = chunk => {
    if (settled) return;
    request = Buffer.concat([request, chunk], request.length + chunk.length);
    if (request.length > 8192) {
      settled = true;
      refuse(client, '431 Request Header Fields Too Large');
      return;
    }
    const boundary = request.indexOf('\r\n\r\n');
    if (boundary < 0) return;
    settled = true;
    const line = request.subarray(0, request.indexOf('\r\n')).toString('ascii');
    const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.[01]$/.exec(line);
    const host = match?.[1];
    if (!host || !allowed.has(host)) {
      refuse(client);
      return;
    }
    const upstream = connect({ host, port: 443 });
    upstream.setTimeout(300_000, () => upstream.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const remainder = request.subarray(boundary + 4);
      if (remainder.length) upstream.write(remainder);
      client.pipe(upstream).pipe(client);
    });
    upstream.once('error', () => refuse(client, '502 Bad Gateway'));
    client.once('error', () => upstream.destroy());
  };
  client.on('data', receive);
  client.once('error', () => undefined);
}).listen(3128, '0.0.0.0');
