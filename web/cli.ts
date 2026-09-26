import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startServer } from './server.ts';
import { createDemo } from '../scripts/demo.ts';
import { requireSupportedNode } from '../runner/store.ts';
import { acquireRunnerLock } from '../runner/recovery.ts';
requireSupportedNode();
const { values } = parseArgs({ options: { demo: { type:'boolean' }, directory:{type:'string'}, config:{type:'string'}, port:{type:'string'}, help:{type:'boolean'} } });
if (values.help || (!values.demo && !values.config)) {
  console.log('codeboost local review\n\nDemo: npm run demo\nExisting store: npm start -- --config /absolute/path/review.json\nOptions: --port 4318 --directory /path/to/demo\n\nThe configuration binds a trusted repository, database, plan identity, and known path identity. Configure the read-only question agent in Settings. A github block enables the guarded merge gate; demos never merge.');
} else {
  const port = Number(values.port ?? '4318');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  const config = values.demo ? createDemo(values.directory ?? '.codeboost-local/demo') : JSON.parse(readFileSync(resolve(values.config!), 'utf8'));
  // Decision 1: one runner per database, held as an OS lock keyed by the database file's device and inode.
  let lock: ReturnType<typeof acquireRunnerLock>;
  try { lock = acquireRunnerLock(config.database); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
  let app: Awaited<ReturnType<typeof startServer>>;
  try { app = await startServer(config, port); }
  catch (error) { lock.release(); throw error; }
  try { lock.verify(); }
  catch (error) { await app.close(); lock.release(); throw error; }
  console.log(`Review ready: ${app.url}\nRepository: ${config.repository}\nDatabase: ${config.database}\nSource files are read-only. Press Ctrl+C to stop.`);
  let stopping=false;
  for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{if(!stopping){stopping=true;void app.close().then(()=>{lock.release();process.exit(0);});}});
}
