import type { JSHandle, Page, TestInfo } from '@playwright/test';
import {
  installNativeInputRecorder,
  type NativeInputRecorder,
  type NativeTimingData,
} from './nativeInputRecorder';

function recordingFailure(data: NativeTimingData): string | null {
  if (data.failure !== null) return data.failure;
  if (
    data.version !== 1 ||
    !data.events.some((event) => event.kind === 'observation') ||
    !data.events.some((event) => event.kind === 'key')
  )
    return 'Missing native observations or key events.';
  for (const [index, event] of data.events.entries()) {
    if (event.sequence !== index) return 'Malformed event sequence.';
    if (event.kind === 'key' && !event.isTrusted)
      return 'Untrusted keyboard event.';
  }
  return null;
}

export async function recordNativeInput<T>(
  page: Pick<Page, 'evaluateHandle'>,
  sink: Pick<TestInfo, 'attach'>,
  operation: (recorder: JSHandle<NativeInputRecorder>) => Promise<T>,
): Promise<T> {
  const recorder = await page.evaluateHandle(
    installNativeInputRecorder,
    32_768,
  );
  const failures: unknown[] = [];
  let result: { value: T } | undefined;
  try {
    result = { value: await operation(recorder) };
  } catch (error) {
    failures.push(error);
  }
  try {
    const data = await recorder.evaluate((value) => value.finish());
    const failure = recordingFailure(data);
    if (failure) failures.push(new Error(`Native input timing: ${failure}`));
    await sink.attach('Native Sunlit input timing', {
      body: Buffer.from(JSON.stringify(data)),
      contentType: 'application/json',
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    await recorder.dispose();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, 'Native input recording failed.');
  if (!result)
    throw new Error('Native input recording has no operation result.');
  return result.value;
}
