import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseNativeTimingPrefix } from './nativeTimingCorpus';

export const SUNLIT_CHORD_PROVENANCE = Object.freeze({
  repository: 'ridermw/reef-rush',
  revision: '3875ba6034b1021587b122a28198ba3cfc2d866f',
  runId: 34013534603,
  jobId: 101433321625,
  eventCount: 47,
  fullSha256:
    'ae658f6a3fe320a6ebaa1314bc18870d8d81990cd557cc7a2046308504bb1cc5',
  prefixSha256:
    'af2f2da6e28032d0a5ccdec4d838266f99fd5f83c18b066b47193766338b0d83',
});

// From the hash-verified, decoded Course Medals attachment: retain records 0-46.
// The prefix digest hashes UTF-8 JSON.stringify({
//   version: full.version, events: full.events.slice(0, 47), failure: full.failure
// }) before file formatting. Timestamps, order, observations and held S are intact.
export function parseSunlitChordWitness(input: unknown) {
  const body = JSON.stringify(input);
  if (
    body === undefined ||
    createHash('sha256').update(body).digest('hex') !==
      SUNLIT_CHORD_PROVENANCE.prefixSha256
  ) {
    throw new Error('Sunlit chord prefix checksum mismatch.');
  }
  return parseNativeTimingPrefix(input);
}

export async function loadSunlitChordWitness() {
  return parseSunlitChordWitness(
    JSON.parse(
      await readFile(
        resolve(
          'tests',
          'fixtures',
          'native-timing',
          'sunlit-34013534603-prefix-964.json',
        ),
        'utf8',
      ),
    ),
  );
}
