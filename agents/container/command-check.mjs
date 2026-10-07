import { openSync, readFileSync, closeSync, fstatSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = process.argv[2];
if (!file || process.argv.length !== 3) process.exit(78);
let fd;
try {
  fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) process.exit(78);
  const commands = JSON.parse(readFileSync(fd, 'utf8'));
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > 100) process.exit(78);
  for (const argv of commands) {
    if (!Array.isArray(argv) || argv.length === 0 || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) process.exit(78);
    const result = spawnSync(argv[0], argv.slice(1), { cwd: '/work', stdio: ['ignore', 'inherit', 'inherit'], shell: false });
    if (result.error) {
      process.stderr.write(`codeboost command check could not start ${JSON.stringify(argv[0])}: ${JSON.stringify(result.error.message)}\n`);
      process.exit(127);
    }
    if (result.signal) {
      process.stderr.write(`codeboost command check ${JSON.stringify(argv[0])} ended by ${result.signal}\n`);
      process.exit(1);
    }
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
} finally {
  if (fd !== undefined) closeSync(fd);
}
