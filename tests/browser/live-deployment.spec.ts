import { test } from '@playwright/test';
import { verifyPublication } from '../fixtures/livePublication';

test('canonical publication matches this revision, HTML and all original GLBs', async ({
  request,
}, testInfo) => {
  const identity = await verifyPublication({
    expectedCommit: process.env.REEF_RUSH_EXPECTED_COMMIT,
    request,
  });
  console.info(`Canonical publication identity: ${JSON.stringify(identity)}`);
  await testInfo.attach('live-publication-identity', {
    body: JSON.stringify(identity),
    contentType: 'application/json',
  });
});
