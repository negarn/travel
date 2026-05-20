import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoDataDirName, demoTravelData } from './demo-data.mjs';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function getDemoDataDir() {
  return resolve(process.cwd(), process.env.TRAVEL_DEMO_DATA_DIR ?? demoDataDirName);
}

async function bestEffortChmod(path, mode) {
  try {
    await fs.chmod(path, mode);
  } catch {
    // Best-effort hardening only. Some filesystems do not support chmod.
  }
}

export async function seedDemoData({
  demoDataDir = getDemoDataDir(),
  onLog = console.log
} = {}) {
  await fs.rm(demoDataDir, { force: true, recursive: true });
  await fs.mkdir(demoDataDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await bestEffortChmod(demoDataDir, PRIVATE_DIRECTORY_MODE);
  await fs.writeFile(
    resolve(demoDataDir, 'travel-data.json'),
    `${JSON.stringify(demoTravelData, null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE
    }
  );
  await bestEffortChmod(resolve(demoDataDir, 'travel-data.json'), PRIVATE_FILE_MODE);

  onLog(`Seeded demo data in ${demoDataDir}`);
  return demoDataDir;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
  await seedDemoData();
}
