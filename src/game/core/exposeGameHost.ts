import type { HostSnapshot } from './GameHost';

export interface ReefRushTestHook {
  readonly getSnapshot: () => HostSnapshot;
}

export function exposeGameHost(getSnapshot: () => HostSnapshot): () => void {
  const hook: ReefRushTestHook = Object.freeze({ getSnapshot });
  window.__REEF_RUSH_TEST__ = hook;
  return () => {
    if (window.__REEF_RUSH_TEST__ === hook) delete window.__REEF_RUSH_TEST__;
  };
}
