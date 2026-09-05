import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { createAppStore, type AppPresentation } from '../../src/app/appStore';
import { GameHost, type HostRenderer } from '../../src/game/core/GameHost';
import { createSceneRuntime } from '../../src/game/core/SceneRuntime';
import { parseCourseDefinition } from '../../src/game/course/courseDefinition';
import { courseFixture } from '../fixtures/courseDefinition';
import { createSettingsStore } from '../../src/settings/SettingsStore';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import { createAudioEngine } from '../../src/game/audio/AudioEngine';
import { FakeContext } from '../fixtures/audioContext';
import { finishAchievements } from '../../src/game/progression/finishAchievements';
import { parseProgress } from '../../src/game/progression/progress';

// JSDOM has the dialog element but no native modal/focus implementation.
// Browser acceptance exercises the real showModal/cancel/focus behavior.
beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    },
  });
});
afterEach(() => vi.restoreAllMocks());

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

describe('graphics recovery shell', () => {
  it('shows conditional WebGL guidance and only offers course retry for a selected course error', async () => {
    const user = userEvent.setup();
    const store = createAppStore();
    store.dispatch({
      type: 'SHOW_ERROR',
      title: 'Run unavailable',
      detail: 'Network disconnected.',
    });
    render(<App store={store} />);
    expect(screen.getByText('Network disconnected.')).toBeVisible();
    expect(
      screen.getByText(
        /if.*graphics.*WebGL 2.*current desktop browser.*hardware acceleration/i,
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Retry course' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Return to title' }));
    await user.click(screen.getByRole('button', { name: 'Dive in' }));
    await user.click(
      screen.getByRole('button', { name: 'Load Sunlit Shoals' }),
    );
    act(() =>
      store.dispatch({
        type: 'SHOW_ERROR',
        title: 'Run unavailable',
        detail: 'Error creating WebGL context.',
      }),
    );
    expect(screen.getByText(/restart.*attempt.*saved progress/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry course' }));
    expect(store.getState()).toMatchObject({
      screen: 'loading',
      selectedCourseId: 'sunlit-shoals',
    });
  });

  it('disables every resume button while lost, keeps settings usable and routes retry through the host', async () => {
    const user = userEvent.setup();
    const store = createAppStore();
    const settings = createSettingsStore(() => ({
      getItem: () => null,
      setItem: () => {},
    }));
    const audio = createAudioEngine();
    const retryCourse = vi.fn(() => store.dispatch({ type: 'RETRY_COURSE' }));
    const unlockAudio = vi.fn(() => audio.unlock());
    store.dispatch({ type: 'OPEN_COURSE_SELECT' });
    store.dispatch({ type: 'LOAD_COURSE', courseId: 'sunlit-shoals' });
    store.dispatch({ type: 'COURSE_READY' });
    store.dispatch({ type: 'GRAPHICS_LOST' });
    store.dispatch({
      type: 'PROGRESS_UPDATED',
      progress: { version: 1, courses: {} },
      notice: null,
    });
    const progress = store.getState().progress;
    render(
      <App
        store={store}
        settings={settings}
        host={{
          settings,
          setContainer: () => {},
          setSettingsOpen: () => {},
          retryCourse,
          inspectSavedProgress: () => ({
            status: 'empty',
            progress: { version: 1, courses: {} },
          }),
          replaceSavedProgress: () => Promise.resolve({ status: 'cancelled' }),
          retrySaving: () => Promise.resolve({ status: 'saved' }),
          unlockAudio,
          getAudioNotice: () => null,
          subscribeAudio: (listener) => audio.subscribe(listener),
          retryAudioCleanup: () => audio.retryCleanup(),
        }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      /graphics interrupted/i,
    );
    for (const name of ['Resume', 'Resume run']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      await user.click(button);
    }
    expect(unlockAudio).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('checkbox', { name: 'Mouse steering' }));
    await user.keyboard('[Escape]');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(store.getState()).toMatchObject({
      screen: 'paused',
      graphicsLost: true,
    });
    const retry = screen.getByRole('button', { name: 'Retry course' });
    retry.focus();
    await user.keyboard('[Enter]');
    expect(retryCourse).toHaveBeenCalledOnce();
    expect(store.getState().progress).toBe(progress);
    expect(settings.getState().settings.mouseSteering).toBe(false);
    expect(screen.queryByText(/graphics interrupted/i)).not.toBeInTheDocument();
    await audio.dispose();
  });

  it('clears the interruption notice on restoration but still requires an explicit resume', async () => {
    const user = userEvent.setup();
    const store = createAppStore();
    store.dispatch({ type: 'OPEN_COURSE_SELECT' });
    store.dispatch({ type: 'LOAD_COURSE', courseId: 'sunlit-shoals' });
    store.dispatch({ type: 'COURSE_READY' });
    store.dispatch({ type: 'GRAPHICS_LOST' });
    render(<App store={store} />);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    act(() => store.dispatch({ type: 'GRAPHICS_RESTORED' }));
    expect(store.getState().screen).toBe('paused');
    expect(screen.queryByText(/graphics interrupted/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry course' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(store.getState().screen).toBe('playing');
  });
});

describe('App shell', () => {
  it('offers expedition copy, never generated/prototype jargon, and no external artwork', () => {
    const view = render(<App store={createAppStore()} />);
    expect(view.container.textContent).not.toMatch(
      /prototype|generated|scene tree|the shell/i,
    );
    expect(screen.getByRole('button', { name: 'Settings' })).toBeVisible();
    expect(
      view.container.querySelectorAll('img[src^="http"],iframe,video'),
    ).toHaveLength(0);
  });

  it('keeps loading and error copy player-facing', () => {
    const store = createAppStore();
    const view = render(<App store={store} />);
    act(() => {
      store.dispatch({ type: 'OPEN_COURSE_SELECT' });
      store.dispatch({ type: 'LOAD_COURSE', courseId: 'sunlit-shoals' });
    });
    expect(view.container.textContent).not.toMatch(
      /physics|render surface|shell/i,
    );
    act(() =>
      store.dispatch({
        type: 'SHOW_ERROR',
        title: 'Run unavailable',
        detail: 'Please try again.',
      }),
    );
    expect(view.container.textContent).not.toMatch(/shell error/i);
  });

  it('edits every native setting immediately and surfaces protected session-only persistence', async () => {
    const user = userEvent.setup();
    const write = vi.fn(() => {
      throw new Error('quota');
    });
    const settings = createSettingsStore(() => ({
      getItem: () => null,
      setItem: write,
    }));
    const view = render(<App store={createAppStore()} settings={settings} />);
    const opener = screen.getByRole('button', { name: 'Settings' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog).toHaveAttribute('tabindex', '-1');
    expect(dialog).toHaveFocus();
    const controls = within(dialog);
    const quality = controls.getByRole('combobox', { name: 'Render quality' });
    expect(quality.tagName).toBe('SELECT');
    expect(quality).toHaveValue('high');
    expect(quality).toHaveAccessibleDescription(
      /game resolution.*shell text.*simulation/i,
    );
    expect(
      within(quality)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['High', 'Medium', 'Low']);
    for (const value of ['medium', 'high', 'low']) {
      await user.selectOptions(quality, value);
      expect(settings.getState().settings.renderQuality).toBe(value);
    }
    const volume = controls.getByRole('slider', { name: 'Master volume' });
    expect(volume).toHaveValue('0.4');
    expect(volume).toHaveAttribute('min', '0');
    expect(volume).toHaveAttribute('max', '1');
    fireEvent.change(volume, { target: { value: '0.2' } });
    const sensitivity = controls.getByRole('slider', {
      name: 'Mouse sensitivity',
    });
    expect(sensitivity).toHaveAttribute('min', '0.25');
    expect(sensitivity).toHaveAttribute('max', '2');
    fireEvent.change(sensitivity, { target: { value: '1.5' } });
    for (const name of [
      'Sound effects',
      'Ambience',
      'Mouse steering',
      'Invert mouse pitch',
      'Reduced effects',
    ]) {
      await user.click(controls.getByRole('checkbox', { name }));
    }
    expect(settings.getState().settings).toEqual({
      ...DEFAULT_SETTINGS,
      masterVolume: 0.2,
      mouseSensitivity: 1.5,
      sfxEnabled: false,
      musicEnabled: true,
      mouseSteering: false,
      invertMouseY: true,
      reducedMotion: true,
      renderQuality: 'low',
    });
    expect(write).toHaveBeenCalledTimes(10);
    expect(controls.getByRole('alert')).toHaveTextContent(
      /could not save settings.*session/i,
    );
    expect(view.container.querySelector('.app-shell')).toHaveAttribute(
      'data-reduced-effects',
      'true',
    );
    await user.click(controls.getByRole('button', { name: 'Close settings' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent(/settings/i);
  });

  it.each(['dialog', 'close', 'range', 'checkbox', 'select'])(
    'contains native keys from %s and restores paused ownership without resuming',
    async (target) => {
      const user = userEvent.setup();
      const store = createAppStore();
      const settings = createSettingsStore(() => ({
        getItem: () => null,
        setItem: () => {},
      }));
      const host = new GameHost(store, {
        settings,
        storage: () => ({ getItem: () => null, setItem: () => {} }),
      });
      // No render surface needed: host's window handler is covered by GameHost
      // tests; this isolates dialog bubbling/containment on native targets.
      const setSettingsOpen = vi.spyOn(host, 'setSettingsOpen');
      store.dispatch({ type: 'OPEN_COURSE_SELECT' });
      store.dispatch({ type: 'LOAD_COURSE', courseId: 'sunlit-shoals' });
      store.dispatch({ type: 'COURSE_READY' });
      store.dispatch({ type: 'PAUSE' });
      const view = render(
        <App
          store={store}
          settings={settings}
          host={{
            settings,
            setContainer: () => {},
            setSettingsOpen,
            retryCourse: host.retryCourse,
            inspectSavedProgress: host.inspectSavedProgress,
            replaceSavedProgress: host.replaceSavedProgress,
            retrySaving: host.retrySaving,
            unlockAudio: host.unlockAudio,
            getAudioNotice: host.getAudioNotice,
            subscribeAudio: host.subscribeAudio,
            retryAudioCleanup: host.retryAudioCleanup,
          }}
        />,
      );
      try {
        const opener = screen.getByRole('button', { name: 'Settings' });
        await user.click(opener);
        expect(setSettingsOpen).toHaveBeenLastCalledWith(true);
        const dialog = screen.getByRole('dialog', { name: 'Settings' });
        const controls = within(dialog);
        const close = controls.getByRole('button', { name: 'Close settings' });
        const last = controls.getByRole('checkbox', {
          name: 'Reduced effects',
        });
        const focus =
          target === 'dialog'
            ? dialog
            : target === 'close'
              ? close
              : target === 'range'
                ? controls.getByRole('slider', { name: 'Master volume' })
                : target === 'select'
                  ? controls.getByRole('combobox', { name: 'Render quality' })
                  : controls.getByRole('checkbox', { name: 'Mouse steering' });
        focus.focus();
        const windowKey = vi.fn();
        window.addEventListener('keydown', windowKey);
        try {
          await user.keyboard(
            target === 'close' ? '[ArrowLeft]' : '[ArrowLeft][Space]',
          );
          expect(windowKey).not.toHaveBeenCalled();
          last.focus();
          await user.tab();
          expect(close).toHaveFocus();
          await user.tab({ shift: true });
          expect(last).toHaveFocus();
          focus.focus();
          await user.keyboard('[Escape]');
        } finally {
          window.removeEventListener('keydown', windowKey);
        }
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
        expect(store.getState().screen).toBe('paused');
        expect(setSettingsOpen).toHaveBeenLastCalledWith(false);
      } finally {
        view.unmount();
        await host.dispose();
      }
    },
  );

  it('unlocks only on load/resume/replay and audio-control gestures, with visible backend retry actions', async () => {
    const user = userEvent.setup();
    const store = createAppStore();
    const settings = createSettingsStore(() => ({
      getItem: () => null,
      setItem: () => {},
    }));
    const context = new FakeContext();
    const audio = createAudioEngine({
      createContext: () => context,
      isUserGesture: () => true,
    });
    const host = new GameHost(store, {
      audio,
      settings,
      storage: () => ({ getItem: () => null, setItem: () => {} }),
    });
    const unlock = vi.spyOn(host, 'unlockAudio');
    const retry = vi.spyOn(host, 'retryAudioCleanup');
    const view = render(
      <App
        store={store}
        settings={settings}
        host={{
          settings,
          setContainer: () => {},
          setSettingsOpen: host.setSettingsOpen,
          retryCourse: host.retryCourse,
          inspectSavedProgress: host.inspectSavedProgress,
          replaceSavedProgress: host.replaceSavedProgress,
          retrySaving: host.retrySaving,
          unlockAudio: unlock,
          getAudioNotice: host.getAudioNotice,
          subscribeAudio: host.subscribeAudio,
          retryAudioCleanup: retry,
        }}
      />,
    );
    try {
      expect(unlock).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Settings' }));
      expect(unlock).not.toHaveBeenCalled();
      await user.click(
        screen.getByRole('checkbox', { name: 'Mouse steering' }),
      );
      await user.selectOptions(
        screen.getByRole('combobox', { name: 'Render quality' }),
        'low',
      );
      expect(unlock).not.toHaveBeenCalled();
      context.resumeError = new DOMException('blocked', 'NotAllowedError');
      await user.click(screen.getByRole('checkbox', { name: 'Ambience' }));
      expect(unlock).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('alert')).toHaveTextContent(/audio.*unlocked/i);
      await user.click(
        screen.getByRole('button', { name: 'Retry audio cleanup' }),
      );
      expect(retry).toHaveBeenCalledTimes(1);
      expect(unlock).toHaveBeenCalledTimes(1);
      context.resumeError = null;
      await user.click(screen.getByRole('button', { name: 'Enable sound' }));
      await user.click(screen.getByRole('button', { name: 'Close settings' }));
      await user.click(screen.getByRole('button', { name: 'Dive in' }));
      await user.click(
        screen.getByRole('button', { name: 'Load Sunlit Shoals' }),
      );
      expect(unlock).toHaveBeenCalledTimes(3);
      act(() => store.dispatch({ type: 'COURSE_READY' }));
      await user.click(screen.getByRole('button', { name: 'Pause run' }));
      await user.click(screen.getByRole('button', { name: 'Resume' }));
      expect(unlock).toHaveBeenCalledTimes(4);
      act(() =>
        store.dispatch({
          type: 'RUN_FINISHED',
          result: {
            courseId: 'sunlit-shoals',
            elapsedMs: 1000,
            medal: 'gold',
            pearlCount: 1,
            totalPearls: 1,
          },
        }),
      );
      await user.click(screen.getByRole('button', { name: 'Race again' }));
      expect(unlock).toHaveBeenCalledTimes(5);
      expect(store.getState().screen).toBe('loading');
    } finally {
      view.unmount();
      await host.dispose();
    }
  });

  it('offers truthful record provenance, actual results, replay and course selection', async () => {
    const user = userEvent.setup();
    const store = createAppStore();
    const result = {
      courseId: 'sunlit-shoals',
      elapsedMs: 21_940.483,
      medal: 'bronze',
      pearlCount: 4,
      totalPearls: 4,
    } as const;
    const prior = parseProgress({
      version: 1,
      courses: {
        'sunlit-shoals': {
          bestElapsedMs: 25_000,
          bestMedal: null,
          bestPearlCount: 1,
        },
      },
    });
    store.dispatch({ type: 'OPEN_COURSE_SELECT' });
    store.dispatch({ type: 'LOAD_COURSE', courseId: 'sunlit-shoals' });
    store.dispatch({ type: 'COURSE_READY' });
    store.dispatch({
      type: 'RUN_FINISHED',
      result,
      achievements: finishAchievements(prior, result),
    });
    render(<App store={store} />);
    expect(screen.getByText('New time record')).toBeVisible();
    expect(screen.getByText('Run complete', { exact: true })).toBeVisible();
    expect(screen.getByText(/progress known at the finish/i)).toBeVisible();
    expect(screen.getByText('Kelpworks: unlocked')).toBeVisible();
    expect(screen.getByText('0:21.94')).toBeVisible();
    expect(screen.getByText(/4 \/ 4 pearls/)).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Choose another course' }),
    );
    expect(
      screen.getByRole('heading', { name: 'Choose a course' }),
    ).toBeVisible();
    // A finish-only shell dispatch does not publish the host's earned progress.
    expect(
      screen.getByRole('button', { name: 'Locked: Kelpworks' }),
    ).toBeDisabled();
  });

  it('announces meaningful race feedback politely without a second status role or contact live flood', () => {
    const store = createAppStore();
    store.dispatch({ type: 'OPEN_COURSE_SELECT' });
    store.dispatch({ type: 'LOAD_COURSE', courseId: 'sunlit-shoals' });
    store.dispatch({ type: 'COURSE_READY' });
    render(<App store={store} />);
    act(() =>
      store.dispatch({
        type: 'PRESENTATION_UPDATED',
        presentation: {
          ...updatedPresentation,
          feedback: {
            cue: 'pearl',
            text: 'Pearl collected',
            announcement: 'Pearl collected',
            sequence: 1,
          },
        },
      }),
    );
    const announcement = screen.getByRole('log', { name: 'Race updates' });
    expect(announcement).toHaveAttribute('aria-live', 'polite');
    expect(announcement).toHaveTextContent('Pearl collected');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() =>
      store.dispatch({
        type: 'PRESENTATION_UPDATED',
        presentation: {
          ...updatedPresentation,
          feedback: {
            cue: 'collision',
            text: 'A close brush',
            announcement: null,
            sequence: 2,
          },
        },
      }),
    );
    expect(announcement).not.toHaveTextContent('A close brush');
  });

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

  it.each(['bronze', 'silver', 'gold'] as const)(
    'enables native Blacksmoker selection after qualifying Sunlit and Kelpworks %s medals',
    async (medal) => {
      const user = userEvent.setup();
      const store = createAppStore();
      store.dispatch({
        type: 'PROGRESS_UPDATED',
        progress: {
          version: 1,
          courses: {
            'sunlit-shoals': {
              bestElapsedMs: 10,
              bestMedal: medal,
              bestPearlCount: 4,
            },
            kelpworks: {
              bestElapsedMs: 20_000,
              bestMedal: medal,
              bestPearlCount: 5,
            },
          },
        },
        notice: null,
      });
      store.dispatch({ type: 'OPEN_COURSE_SELECT' });
      render(<App store={store} />);
      expect(
        screen.getByRole('button', { name: 'Load Kelpworks' }),
      ).toBeEnabled();
      const blacksmoker = screen.getByRole('button', {
        name: 'Load Blacksmoker Run',
      });
      expect(blacksmoker).toBeEnabled();
      expect(blacksmoker.tagName).toBe('BUTTON');
      expect(blacksmoker).toHaveAttribute('type', 'button');
      expect(
        screen.getByRole('button', { name: /Sunlit Shoals/ }),
      ).toBeEnabled();
      expect(screen.queryByText(/not yet available/i)).not.toBeInTheDocument();
      await user.tab();
      expect(
        screen.getByRole('button', { name: 'Load Sunlit Shoals' }),
      ).toHaveFocus();
      await user.tab();
      expect(
        screen.getByRole('button', { name: 'Load Kelpworks' }),
      ).toHaveFocus();
      await user.tab();
      expect(blacksmoker).toHaveFocus();
      await user.keyboard('[Enter]');
      expect(store.getState()).toMatchObject({
        screen: 'loading',
        selectedCourseId: 'blacksmoker-run',
      });
    },
  );

  it('explains both medal qualifications on course selection', () => {
    const store = createAppStore();
    store.dispatch({ type: 'OPEN_COURSE_SELECT' });
    render(<App store={store} />);
    expect(
      screen.getByText(
        /Earn a medal in Sunlit Shoals to unlock Kelpworks, then a medal in Kelpworks to unlock Blacksmoker Run/,
      ),
    ).toBeVisible();
  });

  it.each([false, true])(
    'keeps available Kelpworks locked without a qualifying Sunlit medal (record: %s)',
    (hasRecord) => {
      const store = createAppStore();
      store.dispatch({
        type: 'PROGRESS_UPDATED',
        progress: {
          version: 1,
          courses: hasRecord
            ? {
                'sunlit-shoals': {
                  bestElapsedMs: 31_000,
                  bestMedal: null,
                  bestPearlCount: 4,
                },
              }
            : {},
        },
        notice: null,
      });
      store.dispatch({ type: 'OPEN_COURSE_SELECT' });
      render(<App store={store} />);
      expect(
        screen.getByRole('button', { name: 'Locked: Kelpworks' }),
      ).toBeDisabled();
      expect(
        screen.getByRole('button', {
          name: 'Locked: Blacksmoker Run',
        }),
      ).toBeDisabled();
    },
  );

  it.each([
    { name: 'missing Kelpworks record', sunlit: 'bronze', kelp: undefined },
    { name: 'non-medal Kelpworks finish', sunlit: 'bronze', kelp: null },
    { name: 'orphan Kelpworks medal', sunlit: undefined, kelp: 'gold' },
    { name: 'non-medal Sunlit finish', sunlit: null, kelp: 'gold' },
  ] as const)(
    'keeps Blacksmoker locked with $name despite an orphan final-course medal',
    async ({ sunlit, kelp }) => {
      const user = userEvent.setup();
      const progress = parseProgress({
        version: 1,
        courses: {
          ...(sunlit !== undefined && {
            'sunlit-shoals': {
              bestElapsedMs: 20_000,
              bestMedal: sunlit,
              bestPearlCount: 4,
            },
          }),
          ...(kelp !== undefined && {
            kelpworks: {
              bestElapsedMs: 40_000,
              bestMedal: kelp,
              bestPearlCount: 5,
            },
          }),
          'blacksmoker-run': {
            bestElapsedMs: 30_000,
            bestMedal: 'gold',
            bestPearlCount: 6,
          },
        },
      });
      const store = createAppStore();
      store.dispatch({ type: 'PROGRESS_UPDATED', progress, notice: null });
      store.dispatch({ type: 'OPEN_COURSE_SELECT' });
      render(<App store={store} />);
      const locked = screen.getByRole('button', {
        name: 'Locked: Blacksmoker Run',
      });
      expect(locked).toBeDisabled();
      expect(locked.tagName).toBe('BUTTON');
      await user.click(locked);
      expect(store.getState().screen).toBe('course-select');
      await user.tab();
      expect(
        screen.getByRole('button', { name: 'Load Sunlit Shoals' }),
      ).toHaveFocus();
      if (sunlit) {
        await user.tab();
        expect(
          screen.getByRole('button', { name: 'Load Kelpworks' }),
        ).toHaveFocus();
      }
      await user.tab();
      expect(
        screen.getByRole('button', { name: 'Back to title' }),
      ).toHaveFocus();
      expect(store.getState().progress).toEqual(progress);
    },
  );

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
    const context = new FakeContext();
    const audio = createAudioEngine({
      createContext: () => context,
      isUserGesture: () => true,
    });
    const settings = createSettingsStore(() => ({
      getItem: () => null,
      setItem: () => {},
    }));
    settings.update({ musicEnabled: true });
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
      settings,
      audio,
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
      expect(host.getSnapshot().audio).toMatchObject({
        status: 'ready',
        phase: 'playing',
        activeAmbience: 1,
      });
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
      expect(host.getSnapshot().audio).toMatchObject({
        phase: 'idle',
        ownsContext: true,
        activeEffects: 0,
        activeAmbience: 0,
      });
    } finally {
      view.unmount();
      await host.dispose();
    }
  });
});
