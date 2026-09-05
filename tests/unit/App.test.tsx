import { act, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { createAppStore, type AppPresentation } from '../../src/app/appStore';
import { GameHost, type HostRenderer } from '../../src/game/core/GameHost';
import { createSceneRuntime } from '../../src/game/core/SceneRuntime';
import { parseCourseDefinition } from '../../src/game/course/courseDefinition';
import { courseFixture } from '../fixtures/courseDefinition';

const updatedPresentation: AppPresentation = {
  elapsedMs: 54_320,
  dashRatio: 0.42,
  checkpointIndex: 2,
  checkpointCount: 5,
  pearlCount: 3,
};

function expectGameRoot(expected: 'present' | 'absent'): void {
  const gameRoot = document.querySelector('#game-root');
  if (expected === 'present') {
    expect(gameRoot).not.toBeNull();
  } else {
    expect(gameRoot).toBeNull();
  }
}

describe('App shell', () => {
  it('describes throttle without promising reverse propulsion', () => {
    render(<App store={createAppStore()} />);
    expect(
      screen.getByText('Throttle: increase / reduce forward speed'),
    ).toBeVisible();
    expect(screen.queryByText(/reverse throttle/i)).not.toBeInTheDocument();
  });

  it('opens course selection from the title screen', async () => {
    const user = userEvent.setup();

    render(<App store={createAppStore()} />);
    expectGameRoot('absent');
    await user.click(screen.getByRole('button', { name: 'Dive in' }));

    expect(
      screen.getByRole('heading', { name: 'Choose a course' }),
    ).toBeVisible();
    expectGameRoot('absent');
  });

  it('cancels loading through the native button and removes the render surface', async () => {
    const user = userEvent.setup();
    render(<App store={createAppStore()} />);
    await user.click(screen.getByRole('button', { name: 'Dive in' }));
    await user.click(
      screen.getByRole('button', { name: 'Load Sunlit Shoals' }),
    );
    expectGameRoot('present');
    await user.click(screen.getByRole('button', { name: 'Cancel loading' }));
    expect(screen.getByRole('button', { name: 'Dive in' })).toBeVisible();
    expectGameRoot('absent');
  });

  it('responds to store updates and only mounts the runtime surface on active run screens', () => {
    const store = createAppStore();
    render(<App store={store} />);

    expect(screen.getByRole('heading', { name: 'Reef Rush' })).toBeVisible();
    expectGameRoot('absent');

    act(() => {
      store.dispatch({ type: 'OPEN_COURSE_SELECT' });
    });

    expect(
      screen.getByRole('heading', { name: 'Choose a course' }),
    ).toBeVisible();
    expectGameRoot('absent');

    act(() => {
      store.dispatch({ type: 'LOAD_COURSE', courseId: 'sunlit-shoals' });
    });

    expect(
      screen.getByRole('heading', { name: 'Sunlit Shoals' }),
    ).toBeVisible();
    expectGameRoot('present');

    act(() => {
      store.dispatch({ type: 'COURSE_READY' });
    });

    expect(
      screen.getByRole('heading', { name: 'Sunlit Shoals' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Pause run' })).toBeVisible();
    expectGameRoot('present');

    act(() => {
      store.dispatch({
        type: 'PRESENTATION_UPDATED',
        presentation: updatedPresentation,
      });
    });

    expect(screen.getByText('0:54.32')).toBeVisible();
    expect(screen.getByText('2 / 5')).toBeVisible();
    expect(screen.getByText('42%')).toBeVisible();
    expectGameRoot('present');

    act(() => {
      store.dispatch({ type: 'PAUSE' });
    });

    expect(screen.getByText('Run paused')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
    expectGameRoot('present');

    act(() => {
      store.dispatch({ type: 'RESUME' });
      store.dispatch({
        type: 'RUN_FINISHED',
        result: {
          courseId: 'sunlit-shoals',
          elapsedMs: 91_250,
          medal: 'bronze',
          pearlCount: 3,
          totalPearls: 4,
        },
      });
    });

    expect(screen.getByText('1:31.25')).toBeVisible();
    expect(screen.getByText(/bronze/i)).toBeVisible();
    expect(screen.getByText(/3 \/ 4 pearls/i)).toBeVisible();
    expectGameRoot('present');

    act(() => {
      store.dispatch({
        type: 'SHOW_ERROR',
        title: 'Runtime unavailable',
        detail: 'Lost the gameplay render surface.',
      });
    });

    expect(
      screen.getByRole('heading', { name: 'Runtime unavailable' }),
    ).toBeVisible();
    expectGameRoot('absent');

    act(() => {
      store.dispatch({ type: 'RETURN_TO_TITLE' });
    });

    expect(screen.getByRole('heading', { name: 'Reef Rush' })).toBeVisible();
    expectGameRoot('absent');
  });

  it('keeps unimplemented content disabled even when progression unlocks it', () => {
    const store = createAppStore();
    store.dispatch({
      type: 'PROGRESS_UPDATED',
      progress: {
        version: 1,
        courses: {
          'sunlit-shoals': {
            bestElapsedMs: 10,
            bestMedal: 'gold',
            bestPearlCount: 4,
          },
        },
      },
      notice: null,
    });
    store.dispatch({ type: 'OPEN_COURSE_SELECT' });
    render(<App store={store} />);
    expect(screen.getByRole('button', { name: /Kelpworks/ })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /Blacksmoker Run/ }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: /Sunlit Shoals/ })).toBeEnabled();
    expect(screen.getAllByText(/not yet available/i)).toHaveLength(2);
  });

  it('shows accurate controls rather than shell and unimplemented restart promises', () => {
    render(<App store={createAppStore()} />);
    expect(screen.queryByText('R')).not.toBeInTheDocument();
    expect(screen.queryByText(/static shell today/i)).not.toBeInTheDocument();
    expect(screen.getByText(/throttle/i)).toBeVisible();
  });

  it('displays storage notices on title and completed results without replacing the result', () => {
    const store = createAppStore();
    store.dispatch({
      type: 'PROGRESS_UPDATED',
      progress: { version: 1, courses: {} },
      notice: 'Session-only progress: invalid save preserved.',
    });
    render(<App store={store} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Session-only progress',
    );
    act(() => {
      store.dispatch({ type: 'OPEN_COURSE_SELECT' });
      store.dispatch({ type: 'LOAD_COURSE', courseId: 'sunlit-shoals' });
      store.dispatch({ type: 'COURSE_READY' });
      store.dispatch({
        type: 'RUN_FINISHED',
        result: {
          courseId: 'sunlit-shoals',
          elapsedMs: 21_940.483,
          medal: 'bronze',
          pearlCount: 4,
          totalPearls: 4,
        },
      });
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'invalid save preserved',
    );
    expect(screen.getByText('0:21.94')).toBeVisible();
    expect(screen.getByText(/4 \/ 4 pearls/)).toBeVisible();
  });

  it('lets pointer movement reach water while the complete HUD intercepts it', () => {
    const store = createAppStore();
    store.dispatch({ type: 'OPEN_COURSE_SELECT' });
    store.dispatch({ type: 'LOAD_COURSE', courseId: 'sunlit-shoals' });
    store.dispatch({ type: 'COURSE_READY' });
    const style = document.createElement('style');
    style.textContent = readFileSync(join('src', 'styles', 'app.css'), 'utf8');
    document.head.append(style);
    const view = render(<App store={store} />);
    try {
      expect(
        getComputedStyle(view.container.querySelector('.runtime-overlay')!)
          .pointerEvents,
      ).toBe('none');
      expect(
        getComputedStyle(screen.getByRole('button', { name: 'Pause run' }))
          .pointerEvents,
      ).toBe('auto');
      expect(
        getComputedStyle(
          screen.getByRole('region', { name: 'Run heads-up display' }),
        ).pointerEvents,
      ).toBe('auto');
    } finally {
      style.remove();
    }
  });

  it('keeps one main-owned host across StrictMode, stable roots, buttons and actual remounts', async () => {
    const store = createAppStore();
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    const renderer: HostRenderer = {
      domElement: document.createElement('canvas'),
      setSize: vi.fn(),
      setPixelRatio: vi.fn(),
      render: vi.fn(),
      dispose: vi.fn(),
      forceContextLoss: vi.fn(),
    };
    const createRenderer = vi.fn(() => Promise.resolve(renderer));
    const host = new GameHost(store, {
      createRenderer,
      createScene: createSceneRuntime,
      loadCourse: () => Promise.resolve(parseCourseDefinition(courseFixture())),
      requestFrame: (callback) => {
        frames.set(++id, callback);
        return id;
      },
      cancelFrame: (frame) => {
        frames.delete(frame);
      },
      measure: () => ({ width: 800, height: 400, dpr: 1 }),
      isFocused: () => true,
      observeResize: () => () => {},
      storage: () => ({ getItem: () => null, setItem: () => {} }),
    });
    const user = userEvent.setup();
    let view = render(
      <StrictMode>
        <App store={store} host={host} />
      </StrictMode>,
    );
    try {
      await user.click(screen.getByRole('button', { name: 'Dive in' }));
      await user.click(
        screen.getByRole('button', { name: /Load Sunlit Shoals/ }),
      );
      const root = document.getElementById('game-root');
      await act(() => host.whenIdle());
      expect(store.getState().screen).toBe('playing');
      expect(root?.querySelectorAll('canvas')).toHaveLength(1);
      expect(frames.size).toBe(1);
      await user.click(screen.getByRole('button', { name: 'Pause run' }));
      expect(host.getSnapshot().race?.status).toBe('paused');
      await user.click(screen.getByRole('button', { name: 'Resume' }));
      expect(host.getSnapshot().race?.status).toBe('running');
      expect(document.getElementById('game-root')).toBe(root);
      expect(createRenderer).toHaveBeenCalledOnce();
      view.unmount();
      expect(frames.size).toBe(0);
      view = render(
        <StrictMode>
          <App store={store} host={host} />
        </StrictMode>,
      );
      await act(() => host.whenIdle());
      expect(createRenderer).toHaveBeenCalledOnce();
      expect(document.querySelectorAll('#game-root canvas')).toHaveLength(1);
      expect(frames.size).toBe(1);
      act(() => store.dispatch({ type: 'RETURN_TO_TITLE' }));
      expect(frames.size).toBe(0);
      expect(renderer.dispose).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
      await host.dispose();
    }
  });
});
