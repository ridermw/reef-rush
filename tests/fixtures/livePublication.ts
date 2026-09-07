import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

export const CANONICAL_URL = 'https://ridermw.github.io/reef-rush/';
export const ORIGINAL_ASSETS = [
  'assets/courses/blacksmoker-run.collision.glb',
  'assets/courses/blacksmoker-run.visual.glb',
  'assets/courses/kelpworks.collision.glb',
  'assets/courses/kelpworks.visual.glb',
  'assets/courses/sunlit-shoals.collision.glb',
  'assets/courses/sunlit-shoals.visual.glb',
  'assets/fish/sunfin.glb',
  'assets/props/reef-kit.glb',
] as const;

interface BuildInfo {
  version: 1;
  commit: string;
  indexSha256: string;
}

export interface HttpRequest {
  get(
    url: string,
    options: { timeout: number; maxRedirects: number },
  ): Promise<{
    status(): number;
    body(): Promise<Buffer>;
    dispose(): Promise<void>;
  }>;
}

export function requireCommit(commit: string | undefined): string {
  if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit))
    throw new Error(
      'Expected commit must be exactly 40 lowercase hexadecimal characters',
    );
  return commit;
}

export function productionCommit(
  baseURL: string | undefined,
  expectedCommit: string | undefined,
) {
  if (baseURL === CANONICAL_URL) return requireCommit(expectedCommit);
  if (
    expectedCommit !== undefined ||
    baseURL !== 'http://127.0.0.1:4174/reef-rush/'
  )
    throw new Error(
      `Live production requires the canonical base ${CANONICAL_URL}; local production must not set an expected commit`,
    );
  return undefined;
}

class PropagationPending extends Error {}
const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const transientStatuses = new Set([404, 408, 425, 429, 500, 502, 503, 504]);

async function fetchBytes(request: HttpRequest, url: string, timeout: number) {
  let response;
  try {
    response = await request.get(url, { timeout, maxRedirects: 0 });
  } catch (error) {
    if (
      error instanceof Error &&
      /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b|socket hang up|Timeout \d+ms exceeded/.test(
        error.message,
      )
    )
      throw new PropagationPending(
        `Transient request failure at ${url}: ${error.message}`,
        { cause: error },
      );
    throw error;
  }
  try {
    const status = response.status();
    if (transientStatuses.has(status))
      throw new PropagationPending(`HTTP ${status} at ${url}`);
    if (status !== 200) throw new Error(`HTTP ${status} at ${url}`);
    return await response.body();
  } finally {
    await response.dispose();
  }
}

async function fetchMetadata(
  request: HttpRequest,
  commit: string,
  timeout: number,
): Promise<BuildInfo> {
  const bytes = await fetchBytes(
    request,
    `${CANONICAL_URL}build-info.json`,
    timeout,
  );
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error('Malformed build metadata JSON', { cause: error });
    throw error;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'commit,indexSha256,version' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('commit' in value) ||
    typeof value.commit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(value.commit) ||
    !('indexSha256' in value) ||
    typeof value.indexSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.indexSha256)
  )
    throw new Error(
      'Malformed build metadata: expected exactly version:1, commit and indexSha256',
    );
  if (value.commit !== commit)
    throw new PropagationPending(
      `Stale commit: expected ${commit}, observed ${value.commit}`,
    );
  return { version: 1, commit: value.commit, indexSha256: value.indexSha256 };
}

interface PublicationOptions {
  expectedCommit: string | undefined;
  request: HttpRequest;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readAsset?: (path: string) => Promise<Buffer>;
}

export async function verifyPublication({
  expectedCommit,
  request,
  now = () => performance.now(),
  sleep = async (ms) => {
    await setTimeout(ms);
  },
  readAsset = (path) =>
    readFile(new URL(`../../public/${path}`, import.meta.url)),
}: PublicationOptions) {
  const commit = requireCommit(expectedCommit);
  const deadline = now() + 300_000;
  let lastPending = 'publication verification unfinished';
  const remaining = () => {
    const ms = deadline - now();
    if (ms <= 0)
      throw new Error(
        `Publication exceeded 300000ms total deadline: ${lastPending}`,
      );
    return ms;
  };
  const requestTimeout = () => Math.min(10_000, remaining());

  for (;;) {
    try {
      const info = await fetchMetadata(request, commit, requestTimeout());
      const html = await fetchBytes(request, CANONICAL_URL, requestTimeout());
      remaining();
      const observed = sha256(html);
      if (observed !== info.indexSha256)
        throw new PropagationPending(
          `HTML digest mismatch: expected ${info.indexSha256}, observed ${observed}`,
        );
      const assets: Record<string, string> = {};
      for (const path of ORIGINAL_ASSETS) {
        remaining();
        const original = await readAsset(path);
        const published = await fetchBytes(
          request,
          `${CANONICAL_URL}${path}`,
          requestTimeout(),
        );
        remaining();
        if (!published.equals(original))
          throw new Error(
            `Asset mismatch at ${path}: expected ${sha256(original)}, observed ${sha256(published)}`,
          );
        assets[path] = sha256(published);
      }
      return { ...info, assets };
    } catch (error) {
      if (!(error instanceof PropagationPending)) throw error;
      lastPending = error.message;
      await sleep(Math.min(1_000, remaining()));
    }
  }
}

export interface DocumentResponse {
  url(): string;
  status(): number;
  body(): Promise<Buffer>;
  request(): {
    isNavigationRequest(): boolean;
    resourceType(): string;
    frame(): { parentFrame(): unknown };
  };
}

interface DocumentSource {
  on(
    event: 'response',
    listener: (response: DocumentResponse) => void,
  ): unknown;
  off(
    event: 'response',
    listener: (response: DocumentResponse) => void,
  ): unknown;
}

export function observeLiveDocuments(
  context: DocumentSource,
  expectedCommit: string,
  request: HttpRequest,
) {
  const commit = requireCommit(expectedCommit);
  const pending: Promise<void>[] = [];
  const failures: unknown[] = [];
  const documents: BuildInfo[] = [];
  let canonicalDocuments = 0;

  async function validate(response: DocumentResponse) {
    const navigation = response.request();
    if (
      !navigation.isNavigationRequest() ||
      navigation.resourceType() !== 'document' ||
      navigation.frame().parentFrame() !== null
    )
      return;
    if (response.url() !== CANONICAL_URL)
      throw new Error(
        `Expected canonical main document ${CANONICAL_URL}, observed ${response.url()}`,
      );
    canonicalDocuments++;
    if (response.status() !== 200)
      throw new Error(
        `Main document HTTP ${response.status()} at ${CANONICAL_URL}`,
      );
    const bytes = await response.body();
    const info = await fetchMetadata(request, commit, 10_000);
    const observed = sha256(bytes);
    if (observed !== info.indexSha256)
      throw new Error(
        `Document digest mismatch for commit ${commit}: expected ${info.indexSha256}, observed ${observed}`,
      );
    documents.push(info);
  }
  const onResponse = (response: DocumentResponse) => {
    // EventEmitter does not await listeners; retain every rejection for teardown.
    pending.push(
      validate(response).catch((error: unknown) => {
        failures.push(error);
      }),
    );
  };
  context.on('response', onResponse);
  return {
    async finish() {
      context.off('response', onResponse);
      await Promise.all(pending);
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          failures
            .map((error) =>
              error instanceof Error ? error.message : String(error),
            )
            .join('\n'),
        );
      if (canonicalDocuments === 0)
        throw new Error(
          'No canonical main document was observed in this production test',
        );
      return documents;
    },
  };
}
