import { readFile } from 'node:fs/promises';

export async function enrollmentActive(tokenPath: string): Promise<boolean> {
  try {
    const data: unknown = JSON.parse(await readFile(`${tokenPath}.enrollment-lock`, 'utf8'));
    return typeof data === 'object' && data !== null && 'expiresAt' in data
      && typeof data.expiresAt === 'number' && data.expiresAt > Date.now();
  } catch (error) {
    // A malformed lock fails closed; a missing lock is the normal idle state.
    return !(error instanceof Error && 'code' in error && error.code === 'ENOENT');
  }
}
