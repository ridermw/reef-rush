// @vitest-environment node
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DocumentResponse,
  HttpRequest,
} from '../fixtures/livePublication';

let live: typeof import('../fixtures/livePublication');
beforeEach(async () => {
  const path = '../fixtures/livePublication';
  live = (await import(path)) as typeof live;
});
const canonical = 'https://ridermw.github.io/reef-rush/';
const commit = 'a'.repeat(40);
const html = Buffer.from('<!doctype html>\r\n<html>reef</html>');
const digest = (body: Buffer) =>
  createHash('sha256').update(body).digest('hex');
const metadata = (overrides = {}) => ({
  version: 1,
  commit,
  indexSha256: digest(html),
  ...overrides,
});
const metadataBytes = (overrides = {}) =>
  Buffer.from(JSON.stringify(metadata(overrides)));
const asset = Buffer.from('original glb');
function harness() {
  let time = 0;
  const calls: { url: string; timeout: number }[] = [];
  const response = (body = html, status = 200) => ({
    status: () => status,
    body: () => Promise.resolve(body),
    dispose: vi.fn(() => Promise.resolve()),
  });
  const get = vi.fn<HttpRequest['get']>((url, options) => {
    calls.push({ url, timeout: options.timeout });
    expect(options.maxRedirects).toBe(0);
    return Promise.resolve(
      response(
        url.endsWith('build-info.json')
          ? metadataBytes()
          : url.endsWith('.glb')
            ? asset
            : html,
      ),
    );
  });
  const sleep = vi.fn((ms: number) => {
    time += ms;
    return Promise.resolve();
  });
  return {
    get,
    response,
    calls,
    sleep,
    advance: (ms: number) => {
      time += ms;
    },
    options: {
      expectedCommit: commit,
      request: { get },
      now: () => time,
      sleep,
      readAsset: vi.fn(() => Promise.resolve(asset)),
    },
  };
}

describe('canonical mode', () => {
  it('keeps ordinary local production inert', () => {
    expect(
      live.productionCommit('http://127.0.0.1:4174/reef-rush/', undefined),
    ).toBeUndefined();
    expect(live.productionCommit(canonical, commit)).toBe(commit);
  });
  it.each([
    [canonical, undefined],
    [canonical, ''],
    [canonical, 'A'.repeat(40)],
    ['http://127.0.0.1:4174/reef-rush/', commit],
    ['https://example.com/', commit],
    [`${canonical}?v=1`, commit],
    [undefined, undefined],
    ['invalid', undefined],
  ])('rejects URL/mode mismatch (%s, %s)', (url, sha) => {
    expect(() => live.productionCommit(url, sha)).toThrow();
  });
});

describe('five minute publication readiness', () => {
  it('requires a valid expected revision before any fetch', async () => {
    const h = harness();
    for (const expectedCommit of [
      undefined,
      '',
      'A'.repeat(40),
      'b'.repeat(39),
    ])
      await expect(
        live.verifyPublication({ ...h.options, expectedCommit }),
      ).rejects.toThrow(/40 lowercase hexadecimal/);
    expect(h.get).not.toHaveBeenCalled();
  });
  it('verifies exact HTML and all eight checked-out GLBs without cache busting', async () => {
    const h = harness();
    const result = await live.verifyPublication(h.options);
    expect(result).toEqual({
      ...metadata(),
      assets: Object.fromEntries(
        live.ORIGINAL_ASSETS.map((path) => [path, digest(asset)]),
      ),
    });
    expect(live.ORIGINAL_ASSETS).toEqual([
      'assets/courses/blacksmoker-run.collision.glb',
      'assets/courses/blacksmoker-run.visual.glb',
      'assets/courses/kelpworks.collision.glb',
      'assets/courses/kelpworks.visual.glb',
      'assets/courses/sunlit-shoals.collision.glb',
      'assets/courses/sunlit-shoals.visual.glb',
      'assets/fish/sunfin.glb',
      'assets/props/reef-kit.glb',
    ]);
    expect(h.calls.map(({ url }) => url)).toEqual([
      `${canonical}build-info.json`,
      canonical,
      ...live.ORIGINAL_ASSETS.map((path) => `${canonical}${path}`),
    ]);
    expect(h.options.readAsset.mock.calls).toHaveLength(8);
    expect(h.calls.every(({ timeout }) => timeout === 10_000)).toBe(true);
  });
  it('defaults asset reads to the checked-out public files', async () => {
    const h = harness();
    h.get.mockImplementation(async (url) =>
      h.response(
        url.endsWith('build-info.json')
          ? metadataBytes()
          : url.endsWith('.glb')
            ? await readFile(
                new URL(
                  `../../public/${url.slice(canonical.length)}`,
                  import.meta.url,
                ),
              )
            : html,
      ),
    );
    const { readAsset: unused, ...options } = h.options;
    expect(unused).not.toHaveBeenCalled();
    expect(
      Object.keys((await live.verifyPublication(options)).assets),
    ).toHaveLength(8);
  });
  it('waits for stale commit and mismatched HTML using one clock', async () => {
    const h = harness();
    h.get
      .mockResolvedValueOnce(
        h.response(metadataBytes({ commit: 'b'.repeat(40) })),
      )
      .mockResolvedValueOnce(h.response(metadataBytes()))
      .mockResolvedValueOnce(h.response(Buffer.from('old but playable')));
    expect((await live.verifyPublication(h.options)).commit).toBe(commit);
    expect(h.sleep).toHaveBeenCalledTimes(2);
  });
  it.each([
    'not json',
    'null',
    '[]',
    JSON.stringify({ ...metadata(), extra: true }),
    JSON.stringify({ version: 1, commit }),
    JSON.stringify(metadata({ version: 2 })),
    JSON.stringify(metadata({ commit: 'bad' })),
    JSON.stringify(metadata({ indexSha256: 'F'.repeat(64) })),
  ])('fails malformed metadata immediately (%s)', async (body) => {
    const h = harness();
    h.get.mockResolvedValueOnce(h.response(Buffer.from(body)));
    await expect(live.verifyPublication(h.options)).rejects.toThrow(
      /metadata/i,
    );
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });
  it('fails asset mismatches with the path and observed/expected digests', async () => {
    const h = harness();
    h.get
      .mockResolvedValueOnce(h.response(metadataBytes()))
      .mockResolvedValueOnce(h.response(html))
      .mockResolvedValueOnce(h.response(Buffer.from('wrong glb')));
    await expect(live.verifyPublication(h.options)).rejects.toThrow(
      new RegExp(
        `Asset mismatch.*blacksmoker-run.collision.glb.*${digest(asset)}.*${digest(Buffer.from('wrong glb'))}`,
      ),
    );
    expect(h.sleep).not.toHaveBeenCalled();
  });
  it.each([404, 408, 429, 500, 502, 503, 504])(
    'retries explicit transient HTTP %i then succeeds',
    async (status) => {
      const h = harness();
      h.get.mockResolvedValueOnce(h.response(Buffer.alloc(0), status));
      expect((await live.verifyPublication(h.options)).commit).toBe(commit);
      expect(h.sleep).toHaveBeenCalledTimes(1);
    },
  );
  it.each([301, 400, 401, 403, 410, 501])(
    'fails permanent HTTP %i immediately',
    async (status) => {
      const h = harness();
      h.get.mockResolvedValueOnce(h.response(Buffer.alloc(0), status));
      await expect(live.verifyPublication(h.options)).rejects.toThrow(
        `HTTP ${status}`,
      );
      expect(h.sleep).not.toHaveBeenCalled();
    },
  );
  it.each([
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'apiRequestContext.get: Timeout 10000ms exceeded.',
  ])('retries explicit transient network failure %s', async (message) => {
    const h = harness();
    h.get.mockRejectedValueOnce(new Error(message));
    expect((await live.verifyPublication(h.options)).commit).toBe(commit);
    expect(h.sleep).toHaveBeenCalledTimes(1);
  });
  it('never retries TLS or unknown request failures', async () => {
    for (const message of ['CERT_HAS_EXPIRED', 'unknown bug']) {
      const h = harness();
      h.get.mockRejectedValueOnce(new Error(message));
      await expect(live.verifyPublication(h.options)).rejects.toThrow(message);
      expect(h.sleep).not.toHaveBeenCalled();
    }
  });
  it('includes requests and waits in a single 300000ms total deadline', async () => {
    const h = harness();
    h.get.mockImplementation((_url, options) => {
      h.calls.push({ url: _url, timeout: options.timeout });
      h.advance(options.timeout);
      return Promise.resolve(
        h.response(metadataBytes({ commit: 'b'.repeat(40) })),
      );
    });
    await expect(live.verifyPublication(h.options)).rejects.toThrow(
      /300000ms.*stale commit/i,
    );
    expect(h.options.now()).toBe(300_000);
    expect(
      h.calls.every(({ timeout }) => timeout > 0 && timeout <= 10_000),
    ).toBe(true);
  });
  it('assets share the readiness deadline and receive only the remaining budget', async () => {
    const h = harness();
    h.get.mockImplementationOnce(() => {
      h.advance(299_500);
      return Promise.resolve(h.response(metadataBytes()));
    });
    h.options.readAsset.mockImplementationOnce(() => {
      h.advance(500);
      return Promise.resolve(asset);
    });
    await expect(live.verifyPublication(h.options)).rejects.toThrow(/300000ms/);
    expect(h.calls).toEqual([{ url: canonical, timeout: 500 }]);
  });
  it('propagates local asset read errors', async () => {
    const h = harness();
    h.options.readAsset.mockRejectedValueOnce(new Error('EACCES source GLB'));
    await expect(live.verifyPublication(h.options)).rejects.toThrow(
      'EACCES source GLB',
    );
    expect(h.sleep).not.toHaveBeenCalled();
  });
});

function document(body = html, url = canonical, main = true): DocumentResponse {
  return {
    url: () => url,
    status: () => 200,
    body: () => Promise.resolve(body),
    request: () => ({
      isNavigationRequest: () => true,
      resourceType: () => 'document',
      frame: () => ({ parentFrame: () => (main ? null : {}) }),
    }),
  };
}
describe('actual navigation identity', () => {
  it('rejects a stale but playable navigation after a successful readiness probe', async () => {
    const h = harness();
    await live.verifyPublication(h.options);
    const context = new EventEmitter();
    const tracker = live.observeLiveDocuments(
      context,
      commit,
      h.options.request,
    );
    context.emit('response', document(Buffer.from('old but playable')));
    await expect(tracker.finish()).rejects.toThrow(/Document digest mismatch/);
  });
  it('requires at least one canonical main document', async () => {
    const h = harness();
    const context = new EventEmitter();
    const tracker = live.observeLiveDocuments(
      context,
      commit,
      h.options.request,
    );
    context.emit('response', document(html, canonical, false));
    await expect(tracker.finish()).rejects.toThrow(
      /No canonical main document/,
    );
  });
  it('validates every reload and additional context page and detaches on teardown', async () => {
    const h = harness();
    const context = new EventEmitter();
    const tracker = live.observeLiveDocuments(
      context,
      commit,
      h.options.request,
    );
    for (let pageOrReload = 0; pageOrReload < 3; pageOrReload++)
      context.emit('response', document());
    const result = await tracker.finish();
    expect(result).toEqual([metadata(), metadata(), metadata()]);
    expect(h.get).toHaveBeenCalledTimes(3);
    expect(context.listenerCount('response')).toBe(0);
  });
  it('does not accept an earlier valid document in place of a stale reload/new page', async () => {
    const h = harness();
    const context = new EventEmitter();
    const tracker = live.observeLiveDocuments(
      context,
      commit,
      h.options.request,
    );
    context.emit('response', document());
    context.emit('response', document(Buffer.from('stale additional page')));
    await expect(tracker.finish()).rejects.toThrow(/Document digest mismatch/);
  });
  it('requires expected metadata on each navigation, without propagation retries', async () => {
    const h = harness();
    h.get.mockResolvedValueOnce(
      h.response(metadataBytes({ commit: 'b'.repeat(40) })),
    );
    const context = new EventEmitter();
    const tracker = live.observeLiveDocuments(
      context,
      commit,
      h.options.request,
    );
    context.emit('response', document());
    await expect(tracker.finish()).rejects.toThrow(/stale commit/i);
    expect(h.get).toHaveBeenCalledTimes(1);
  });
  it('awaits asynchronous response reads and surfaces their failures', async () => {
    const h = harness();
    const context = new EventEmitter();
    const tracker = live.observeLiveDocuments(
      context,
      commit,
      h.options.request,
    );
    let rejectBody: (error: Error) => void = () => {
      throw new Error('body not started');
    };
    const pending = new Promise<Buffer>((_resolve, reject) => {
      rejectBody = reject;
    });
    context.emit('response', { ...document(), body: () => pending });
    const finished = tracker.finish();
    let settled = false;
    void finished.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    rejectBody(new Error('response body unavailable'));
    await expect(finished).rejects.toThrow(/response body unavailable/);
  });
  it('rejects unexpected document URLs and bad revisions without metadata requests', async () => {
    const h = harness();
    const context = new EventEmitter();
    expect(() =>
      live.observeLiveDocuments(context, 'bad', h.options.request),
    ).toThrow(/40 lowercase hexadecimal/);
    const tracker = live.observeLiveDocuments(
      context,
      commit,
      h.options.request,
    );
    context.emit('response', document(html, 'https://example.com/'));
    await expect(tracker.finish()).rejects.toThrow(/canonical/);
    expect(h.get).not.toHaveBeenCalled();
  });
});
