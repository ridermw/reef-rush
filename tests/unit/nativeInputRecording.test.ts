import { runInNewContext } from 'node:vm';
import type { JSHandle, Page, TestInfo } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import type {
  NativeInputRecorder,
  NativeTimingData,
} from '../fixtures/nativeInputRecorder';
import { recordNativeInput } from '../fixtures/nativeInputRecording';
import { deferred } from '../fixtures/originalAssets';

function setup() {
  expect(recordNativeInput).toBeTypeOf('function');
  if (!recordNativeInput)
    throw new Error('Missing native recording lifecycle.');
  const stamp = {
    screen: 'playing' as const,
    steps: 5,
    rendered: 3,
    inputResets: 1,
    settingsOpen: false,
    graphicsLost: false,
  };
  const data: NativeTimingData = {
    version: 1,
    failure: null,
    events: [
      {
        ...stamp,
        kind: 'observation',
        sequence: 0,
        time: 1,
        anchor: {
          player: {
            position: [0, -3, 0],
            velocity: [0, 0, 1],
            yaw: 0,
            pitch: 0,
            roll: 0,
            dashEnergy: 1,
            isSubmerged: true,
          },
          courseId: 'sunlit-shoals',
          elapsedMs: 0,
          checkpointIndex: 0,
          pearlCount: 0,
          status: 'running',
          collectedPearlIds: [],
          mouseSteering: false,
        },
      },
      {
        ...stamp,
        kind: 'key',
        sequence: 1,
        time: 2,
        type: 'keydown',
        code: 'KeyW',
        repeat: false,
        isTrusted: true,
        defaultPrevented: true,
        canvasTarget: true,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      },
    ],
  };
  const finish = vi.fn<NativeInputRecorder['finish']>().mockResolvedValue(data);
  const recorder: NativeInputRecorder = { observe: vi.fn(), finish };
  const evaluate = vi.fn<JSHandle<NativeInputRecorder>['evaluate']>();
  evaluate.mockImplementation(async (callback) => {
    if (typeof callback !== 'function')
      throw new Error('Expected browser function.');
    const result: unknown = runInNewContext(
      `(${callback.toString()})(recorder)`,
      { recorder },
    );
    return await result;
  });
  const dispose = vi
    .fn<JSHandle<NativeInputRecorder>['dispose']>()
    .mockResolvedValue();
  const handle: Pick<JSHandle<NativeInputRecorder>, 'evaluate' | 'dispose'> = {
    evaluate,
    dispose,
  };
  const page: Pick<Page, 'evaluateHandle'> = {
    evaluateHandle: vi.fn<Page['evaluateHandle']>().mockResolvedValue(handle),
  };
  const attach = vi.fn<TestInfo['attach']>().mockResolvedValue();
  const operation = vi.fn(() => Promise.resolve('actual result'));
  return {
    run: () => recordNativeInput(page, { attach }, operation),
    data,
    finish,
    evaluate,
    dispose,
    attach,
    operation,
    handle,
    page,
  };
}

it('attaches and disposes exactly once after the operation settles', async () => {
  const h = setup();
  const gate = deferred<string>();
  h.operation.mockReturnValue(gate.promise);
  const completion = h.run();
  await vi.waitFor(() => expect(h.operation).toHaveBeenCalledWith(h.handle));
  expect(h.finish).not.toHaveBeenCalled();
  gate.resolve('earned result');
  expect(await completion).toBe('earned result');
  expect(h.finish).toHaveBeenCalledTimes(1);
  expect(h.dispose).toHaveBeenCalledTimes(1);
  expect(h.attach).toHaveBeenCalledWith('Native Sunlit input timing', {
    body: Buffer.from(JSON.stringify(h.data)),
    contentType: 'application/json',
  });
});

it('retains the original operation failure after successful evidence cleanup', async () => {
  const h = setup();
  const failure = new Error('original driver failure');
  h.operation.mockRejectedValue(failure);
  await expect(h.run()).rejects.toBe(failure);
  expect(h.finish).toHaveBeenCalledTimes(1);
  expect(h.attach).toHaveBeenCalledTimes(1);
  expect(h.dispose).toHaveBeenCalledTimes(1);
});

it.each(['finish', 'attach'])(
  'preserves operation, %s and disposal errors',
  async (phase) => {
    const h = setup();
    const original = new Error('original driver failure');
    const capture = new Error(`${phase} failed`);
    const disposal = new Error('disposal failed');
    h.operation.mockRejectedValue(original);
    h[phase === 'finish' ? 'finish' : 'attach'].mockRejectedValue(capture);
    h.dispose.mockRejectedValue(disposal);
    const failure = await h.run().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      original,
      capture,
      disposal,
    ]);
    expect(h.finish).toHaveBeenCalledTimes(1);
    expect(h.dispose).toHaveBeenCalledTimes(1);
  },
);

it.each(['recorder', 'trust', 'sequence', 'empty'])(
  'attaches %s failure evidence before rejecting it',
  async (kind) => {
    const h = setup();
    let data = h.data;
    if (kind === 'recorder') data = { ...data, failure: 'capacity exhausted' };
    if (kind === 'trust')
      data = {
        ...data,
        events: data.events.map((event) =>
          event.kind === 'key' ? { ...event, isTrusted: false } : event,
        ),
      };
    if (kind === 'sequence')
      data = {
        ...data,
        events: data.events.map((event) => ({ ...event, sequence: 9 })),
      };
    if (kind === 'empty') data = { ...data, events: [] };
    h.finish.mockResolvedValue(data);
    await expect(h.run()).rejects.toThrow(/Native input timing/i);
    expect(h.attach).toHaveBeenCalledTimes(1);
    expect(h.dispose).toHaveBeenCalledTimes(1);
  },
);

it('combines invalid evidence with attachment and original operation failures', async () => {
  const h = setup();
  const original = new Error('driver failed');
  const attachment = new Error('attachment failed');
  h.operation.mockRejectedValue(original);
  h.finish.mockResolvedValue({ ...h.data, failure: 'owner changed' });
  h.attach.mockRejectedValue(attachment);
  const failure = await h.run().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError))
    throw new Error('Missing combined failure.');
  expect(failure.errors).toHaveLength(3);
  expect(failure.errors[0]).toBe(original);
  expect(failure.errors[1]).toHaveProperty(
    'message',
    'Native input timing: owner changed',
  );
  expect(failure.errors[2]).toBe(attachment);
  expect(h.dispose).toHaveBeenCalledTimes(1);
});
