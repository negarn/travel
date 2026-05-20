import { spawn } from 'node:child_process';
import { seedDemoData } from './seed-demo-data.mjs';

const demoPort = '5174';
const demoDataDir = await seedDemoData({ onLog: console.log });

const child = spawn('vite', ['--port', demoPort, '--strictPort', ...process.argv.slice(2)], {
  env: {
    ...process.env,
    TRAVEL_DATA_DIR: demoDataDir
  },
  stdio: 'inherit'
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
