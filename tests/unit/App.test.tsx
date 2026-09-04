import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app/App';
import { createAppStore, type AppPresentation } from '../../src/app/appStore';

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
      store.dispatch({ type: 'RUN_FINISHED', elapsedMs: 91_250 });
    });

    expect(screen.getByText('1:31.25')).toBeVisible();
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
});
