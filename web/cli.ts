import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startServer } from './server.ts';
import { createDemo } from '../scripts/demo.ts';
import { requireSupportedNode } from '../runner/store.ts';
requireSupportedNode();
const { values } = parseArgs({ options: { demo: { type:'boolean' }, directory:{type:'string'}, config:{type:'string'}, port:{type:'string'}, help:{type:'boolean'} } });
if (values.help || (!values.demo && !values.config)) {
  console.log('codeboost local review\n\nDemo: npm run demo\nExisting store: npm start -- --config /absolute/path/review.json\nOptions: --port 4318 --directory /path/to/demo\n\nThe configuration binds a trusted repository, database, plan identity, and known path identity. Configure the read-only question agent in Settings. A github block enables the guarded merge gate; demos never merge.');
} else {
  const port = Number(values.port ?? '4318');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  const config = values.demo ? createDemo(values.directory ?? '.codeboost-local/demo') : JSON.parse(readFileSync(resolve(values.config!), 'utf8'));
  const app = await startServer(config, port);
  console.log(`Review ready: ${app.url}\nRepository: ${config.repository}\nDatabase: ${config.database}\nSource files are read-only. Press Ctrl+C to stop.`);
  let stopping=false;
  for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{if(!stopping){stopping=true;void app.close().then(()=>process.exit(0));}});
}
