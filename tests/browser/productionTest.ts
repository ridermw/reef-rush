import { test as base } from '@playwright/test';
import {
  observeLiveDocuments,
  productionCommit,
} from '../fixtures/livePublication';

export { expect, type Locator, type Page } from '@playwright/test';

export const test = base.extend<{ publication: void }>({
  publication: [
    async ({ baseURL, context, request }, runTest, testInfo) => {
      const commit = productionCommit(
        baseURL,
        process.env.REEF_RUSH_EXPECTED_COMMIT,
      );
      if (commit === undefined) {
        await runTest();
        return;
      }
      const tracker = observeLiveDocuments(context, commit, request);
      try {
        await runTest();
      } finally {
        const documents = await tracker.finish();
        await testInfo.attach('live-navigation-identity', {
          body: JSON.stringify(documents),
          contentType: 'application/json',
        });
      }
    },
    { auto: true },
  ],
});
