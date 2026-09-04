import { describe, expect, it } from 'vitest';
import { createAppStore } from '../../src/app/appStore';

describe('app screen transitions', () => {
  it('runs title -> select -> loading -> playing -> results', () => {
    const store = createAppStore();
    store.dispatch({ type: 'OPEN_COURSE_SELECT' });
    store.dispatch({ type: 'LOAD_COURSE', courseId: 'sunlit-shoals' });
    store.dispatch({ type: 'COURSE_READY' });
    store.dispatch({ type: 'RUN_FINISHED', elapsedMs: 91_250 });

    expect(store.getState()).toMatchObject({
      screen: 'results',
      selectedCourseId: 'sunlit-shoals',
      result: { elapsedMs: 91_250 },
    });
  });

  it('rejects pause outside an active run', () => {
    const store = createAppStore();

    expect(() => store.dispatch({ type: 'PAUSE' })).toThrow(
      'Cannot PAUSE while screen is title',
    );
  });
});
