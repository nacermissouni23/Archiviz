import * as path from 'node:path';

export function parseArgs(argv: string[]) {
  let target = process.cwd();
  let port = 4840;
  const flags = { open: true };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      port = Number(argv[++i]) || port;
    } else if (a === '--no-open') {
      flags.open = false;
    } else if (a === '-h' || a === '--help') {
      console.log('archi [path] [--port N] [--no-open]');
      process.exit(0);
    } else if (!a.startsWith('-')) {
      target = a;
    }
  }
  return { target: path.resolve(target), port, ...flags };
}
