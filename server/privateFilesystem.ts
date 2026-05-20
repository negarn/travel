import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function getTempFilePath(filePath: string) {
  return `${filePath}.${process.pid}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}.tmp`;
}

async function bestEffortChmod(path: string, mode: number) {
  try {
    await fs.chmod(path, mode);
  } catch {
    // Some filesystems do not support chmod. The write still succeeds.
  }
}

export async function ensurePrivateJsonStorageFile(filePath: string) {
  const directoryPath = dirname(filePath);

  await fs.mkdir(directoryPath, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  await bestEffortChmod(directoryPath, PRIVATE_DIRECTORY_MODE);
  await bestEffortChmod(filePath, PRIVATE_FILE_MODE);
}

export async function writePrivateJsonFile(filePath: string, value: unknown) {
  await ensurePrivateJsonStorageFile(filePath);

  const tempFilePath = getTempFilePath(filePath);

  try {
    await fs.writeFile(tempFilePath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE
    });
    await fs.rename(tempFilePath, filePath);
    await bestEffortChmod(filePath, PRIVATE_FILE_MODE);
  } catch (error) {
    await fs.rm(tempFilePath, { force: true }).catch(() => undefined);
    throw error;
  }
}
