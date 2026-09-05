import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { createAppStore } from '../../src/app/appStore';
import {
  GameHost,
  type GameHostDependencies,
} from '../../src/game/core/GameHost';
import { emptyProgress } from '../../src/game/progression/progress';
import type { StorageLike } from '../../src/game/save/progressStorage';
import type { AppScreen } from '../../src/app/screens';

const hosts: GameHost[] = [];
const createURL = vi.fn(() => 'blob:owned-backup');
const revokeURL = vi.fn();

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
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: createURL },
    revokeObjectURL: { configurable: true, value: revokeURL },
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  createURL.mockReset().mockReturnValue('blob:owned-backup');
  revokeURL.mockClear();
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  vi.restoreAllMocks();
});

function setup(
  raw: string | null = '{broken',
  initialScreen: AppScreen = 'title',
  coordinateProgress: GameHostDependencies['coordinateProgress'] = (save) =>
    Promise.resolve().then(save),
) {
  const state = { raw, readable: true, writable: true };
  const storage: StorageLike = {
    getItem: () => {
      if (!state.readable) throw new Error('Storage blocked');
      return state.raw;
    },
    setItem: (_key, value) => {
      if (!state.writable) throw new Error('Quota exhausted');
      state.raw = value;
    },
  };
  const store = createAppStore();
  const host = new GameHost(store, {
    storage: () => storage,
    coordinateProgress,
  });
  hosts.push(host);
  if (
    initialScreen === 'course-select' ||
    ['loading', 'playing', 'paused', 'results'].includes(initialScreen)
  )
    store.dispatch({ type: 'OPEN_COURSE_SELECT' });
  if (['loading', 'playing', 'paused', 'results'].includes(initialScreen))
    store.dispatch({ type: 'LOAD_COURSE', courseId: 'sunlit-shoals' });
  if (['playing', 'paused', 'results'].includes(initialScreen))
    store.dispatch({ type: 'COURSE_READY' });
  if (initialScreen === 'paused') store.dispatch({ type: 'PAUSE' });
  if (initialScreen === 'results')
    store.dispatch({
      type: 'RUN_FINISHED',
      result: {
        courseId: 'sunlit-shoals',
        elapsedMs: 50000,
        medal: null,
        pearlCount: 0,
        totalPearls: 4,
      },
    });
  if (initialScreen === 'error')
    store.dispatch({
      type: 'SHOW_ERROR',
      title: 'Run unavailable',
      detail: 'Try again.',
    });
  const view = render(
    <App store={store} host={{ ...host, setContainer: () => {} }} />,
  );
  return { state, host, store, view };
}

async function open() {
  await userEvent.click(screen.getByRole('button', { name: 'Saved progress' }));
  return within(screen.getByRole('dialog', { name: 'Saved progress' }));
}

describe('protected saved progress dialog', () => {
  it.each(['title', 'course-select', 'paused', 'results', 'error'] as const)(
    'offers stable recovery without starting or resuming on %s',
    async (screenName) => {
      const h = setup('{broken', screenName);
      const before = h.store.getState();
      const opener = screen.getByRole('button', { name: 'Saved progress' });
      const controls = await open();
      expect(controls.getByText(/malformed JSON/i)).toBeVisible();
      await userEvent.click(
        controls.getByRole('button', { name: 'Close saved progress' }),
      );
      expect(h.store.getState()).toBe(before);
      expect(opener).toHaveFocus();
    },
  );

  it.each(['playing', 'loading'] as const)(
    'does not offer recovery during %s',
    (screenName) => {
      setup('{broken', screenName);
      expect(
        screen.queryByRole('button', { name: 'Saved progress' }),
      ).not.toBeInTheDocument();
    },
  );

  it('uses typed fresh inspection, explicit acknowledgment and current-session copy; retains the opener after success', async () => {
    const h = setup();
    const opener = screen.getByRole('button', { name: 'Saved progress' });
    act(() =>
      h.store.dispatch({
        type: 'PROGRESS_UPDATED',
        progress: emptyProgress(),
        notice: 'unrelated human text',
      }),
    );
    const controls = await open();
    expect(
      controls.getByText(/actually earned.*current session/i),
    ).toBeVisible();
    expect(
      controls.getByRole('button', { name: 'Download backup' }),
    ).toBeEnabled();
    const confirm = controls.getByRole('button', {
      name: 'Replace invalid save',
    });
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm);
    expect(h.state.raw).toBe('{broken');
    await userEvent.click(
      controls.getByRole('checkbox', { name: /replace.*original/i }),
    );
    await userEvent.click(confirm);
    expect(h.state.raw).toBe(JSON.stringify(emptyProgress()));
    expect(controls.getByRole('status')).toHaveTextContent(
      /saved.*current session/i,
    );
    expect(controls.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(h.store.getState().progressNotice).toBeNull();
    await userEvent.click(
      controls.getByRole('button', { name: 'Close saved progress' }),
    );
    expect(opener).toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it.each([
    [JSON.stringify(emptyProgress()), /valid saved progress/i],
    [null, /no saved progress/i],
    ['{"version":99,"future":true}', /newer or different version/i],
  ])('never offers replacement for %s', async (raw, copy) => {
    setup(raw);
    const controls = await open();
    expect(controls.getByText(copy)).toBeVisible();
    expect(
      controls.queryByRole('button', { name: 'Replace invalid save' }),
    ).not.toBeInTheDocument();
    expect(controls.queryByRole('checkbox')).not.toBeInTheDocument();
    if (raw?.includes('99')) {
      expect(
        controls.getByRole('button', { name: 'Download backup' }),
      ).toBeEnabled();
      expect(
        controls.queryByRole('button', { name: 'Retry saving' }),
      ).not.toBeInTheDocument();
    }
  });

  it('surfaces unavailable and failed writes, permits an explicit ordinary retry after external repair', async () => {
    const h = setup();
    h.state.readable = false;
    const controls = await open();
    expect(controls.getByText(/storage.*unavailable/i)).toBeVisible();
    expect(
      controls.queryByRole('button', { name: 'Replace invalid save' }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      controls.getByRole('button', { name: 'Retry saving' }),
    );
    expect(controls.getByRole('alert')).toHaveTextContent(/could not save/i);
    h.state.readable = true;
    h.state.raw = JSON.stringify(emptyProgress());
    h.state.writable = false;
    await userEvent.click(
      controls.getByRole('button', { name: 'Retry saving' }),
    );
    expect(controls.getByRole('alert')).toHaveTextContent(/could not save/i);
    h.state.writable = true;
    await userEvent.click(
      controls.getByRole('button', { name: 'Retry saving' }),
    );
    expect(controls.getByRole('status')).toHaveTextContent(/saved/i);
  });

  it('refreshes stale authorization, resets acknowledgment and never silently retries replacement', async () => {
    const h = setup();
    const controls = await open();
    await userEvent.click(controls.getByRole('checkbox'));
    h.state.raw = '{"version":1,"courses":{"unknown":{}}}';
    await userEvent.click(
      controls.getByRole('button', { name: 'Replace invalid save' }),
    );
    expect(controls.getByRole('alert')).toHaveTextContent(
      /changed.*not replaced/i,
    );
    expect(controls.getByRole('checkbox')).not.toBeChecked();
    expect(
      controls.getByRole('button', { name: 'Replace invalid save' }),
    ).toBeDisabled();
    expect(h.state.raw).toContain('unknown');
    await userEvent.click(controls.getByRole('checkbox'));
    await userEvent.click(
      controls.getByRole('button', { name: 'Inspect again' }),
    );
    expect(controls.getByRole('checkbox')).not.toBeChecked();
    await userEvent.keyboard('[Escape]');
    const reopened = await open();
    expect(reopened.getByRole('checkbox')).not.toBeChecked();
  });

  it('disables confirmation while queued and cancels on close before the held transaction writes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = setup('{broken', 'title', async (save) => {
      await gate;
      save();
    });
    try {
      const controls = await open();
      await userEvent.click(controls.getByRole('checkbox'));
      await userEvent.click(
        controls.getByRole('button', { name: 'Replace invalid save' }),
      );
      expect(
        controls.getByRole('button', { name: 'Replace invalid save' }),
      ).toBeDisabled();
      expect(controls.getByRole('checkbox')).toBeDisabled();
      expect(controls.getByRole('status')).toHaveTextContent(/waiting/i);
      await userEvent.click(
        controls.getByRole('button', { name: 'Close saved progress' }),
      );
    } finally {
      release();
    }
    await act(() => h.host.whenIdle());
    expect(h.state.raw).toBe('{broken');
    expect(h.store.getState().progressNotice).toMatch(/cancelled/i);
    const controls = await open();
    expect(controls.getByRole('checkbox')).not.toBeChecked();
  });

  it('discards modal ownership and authorization across an external screen change instead of reopening later', async () => {
    const h = setup();
    const controls = await open();
    await userEvent.click(controls.getByRole('checkbox'));
    act(() => {
      h.store.dispatch({ type: 'OPEN_COURSE_SELECT' });
      h.store.dispatch({ type: 'LOAD_COURSE', courseId: 'sunlit-shoals' });
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => h.store.dispatch({ type: 'RETURN_TO_TITLE' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const reopened = await open();
    expect(reopened.getByRole('checkbox')).not.toBeChecked();
  });

  it('prevents a backup attempt while replacement is waiting for the save lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = setup('{broken', 'title', async (save) => {
      await gate;
      save();
    });
    const controls = await open();
    try {
      await userEvent.click(controls.getByRole('checkbox'));
      await userEvent.click(
        controls.getByRole('button', { name: 'Replace invalid save' }),
      );
      createURL.mockImplementationOnce(() => {
        throw new Error('Backup allocation failed');
      });
      const backup = controls.getByRole('button', { name: 'Download backup' });
      await userEvent.click(backup);
      expect(createURL).not.toHaveBeenCalled();
      expect(backup).toBeDisabled();
      expect(h.state.raw).toBe('{broken');
      expect(controls.getByRole('status')).toHaveTextContent(/waiting/i);
    } finally {
      release();
      await act(() => h.host.whenIdle());
    }
    expect(h.state.raw).toBe(JSON.stringify(emptyProgress()));
    expect(controls.getByRole('status')).toHaveTextContent(/saved/i);
  });

  it('blocks replacement after backup failure until an explicit backup retry succeeds', async () => {
    const h = setup();
    const controls = await open();
    await userEvent.click(controls.getByRole('checkbox'));
    createURL.mockImplementationOnce(() => {
      throw new Error('Backup allocation failed');
    });
    const backup = controls.getByRole('button', { name: 'Download backup' });
    await userEvent.click(backup);
    expect(controls.getByRole('alert')).toHaveTextContent(
      /could not create.*backup.*allocation failed/i,
    );
    const confirm = controls.getByRole('button', {
      name: 'Replace invalid save',
    });
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm);
    expect(h.state.raw).toBe('{broken');
    await userEvent.click(backup);
    expect(controls.queryByRole('alert')).not.toBeInTheDocument();
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(h.state.raw).toBe(JSON.stringify(emptyProgress()));
  });

  it('bounds raw React text and owns lossless backup URLs through refresh, repeated downloads and close', async () => {
    const raw = '<img src=x onerror=alert(1)>' + 'x'.repeat(5000) + '\ud800';
    const h = setup(raw);
    const controls = await open();
    const preview = controls.getByLabelText('Saved data preview');
    expect(preview.textContent).toBe(raw.slice(0, 4096));
    expect(preview.querySelector('img')).toBeNull();
    expect(
      controls.getByText(
        `Showing 4096 of ${raw.length} UTF-16 code units (preview truncated).`,
      ),
    ).toBeVisible();
    await userEvent.click(
      controls.getByRole('button', { name: 'Download backup' }),
    );
    expect(createURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(revokeURL).not.toHaveBeenCalled();
    await userEvent.click(
      controls.getByRole('button', { name: 'Download backup' }),
    );
    expect(revokeURL).toHaveBeenCalledTimes(1);
    h.state.raw = '{different';
    await userEvent.click(
      controls.getByRole('button', { name: 'Inspect again' }),
    );
    expect(revokeURL).toHaveBeenCalledTimes(2);
    await userEvent.click(
      controls.getByRole('button', { name: 'Download backup' }),
    );
    await userEvent.keyboard('[Escape]');
    expect(revokeURL).toHaveBeenCalledTimes(3);
  });

  it.each(['dialog', 'close', 'backup', 'acknowledgment', 'confirm'] as const)(
    'owns Escape and restores focus without resuming from %s',
    async (target) => {
      const h = setup('{broken', 'paused');
      const controls = await open();
      const dialog = screen.getByRole('dialog');
      await userEvent.click(controls.getByRole('checkbox'));
      const focus = {
        dialog,
        close: controls.getByRole('button', { name: 'Close saved progress' }),
        backup: controls.getByRole('button', { name: 'Download backup' }),
        acknowledgment: controls.getByRole('checkbox'),
        confirm: controls.getByRole('button', { name: 'Replace invalid save' }),
      }[target];
      focus.focus();
      const listener = vi.fn();
      window.addEventListener('keydown', listener);
      try {
        fireEvent.keyDown(focus, { key: 'ArrowLeft' });
        expect(listener).not.toHaveBeenCalled();
        await userEvent.keyboard('[Escape]');
      } finally {
        window.removeEventListener('keydown', listener);
      }
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(h.store.getState().screen).toBe('paused');
      expect(
        screen.getByRole('button', { name: 'Saved progress' }),
      ).toHaveFocus();
    },
  );
});
