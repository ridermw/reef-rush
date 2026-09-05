import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsDialog } from '../../src/app/components/DiagnosticsDialog';
import { GameHost } from '../../src/game/core/GameHost';
import { createAppStore } from '../../src/app/appStore';
import { createFrameMetrics } from '../../src/game/core/frameMetrics';

const hosts: GameHost[] = [];
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
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  vi.restoreAllMocks();
});

function setup() {
  const store = createAppStore();
  const host = new GameHost(store, {
    storage: () => ({ getItem: () => null, setItem: () => {} }),
  });
  hosts.push(host);
  const read = vi.spyOn(host, 'getDiagnostics');
  const onClose = vi.fn();
  return { store, host, read, onClose };
}

describe('manual local diagnostics dialog', () => {
  it('reads once, labels empty metrics honestly, and never refreshes on rerender, shell changes or elapsed time', async () => {
    const h = setup();
    const initial = h.host.getDiagnostics();
    h.read.mockClear();
    const view = render(
      <DiagnosticsDialog host={h.host} onClose={h.onClose} />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Diagnostics' });
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog).toHaveFocus();
    const controls = within(dialog);
    expect(h.read).toHaveBeenCalledOnce();
    expect(controls.getAllByText('No running samples')).toHaveLength(3);
    expect(controls.getByText('No canvas')).toBeVisible();
    expect(controls.getByText(/local.*manual snapshot/i)).toBeVisible();
    expect(controls.getByText(/CPU.*not GPU/i)).toBeVisible();
    expect(
      controls.getByText(/counts.*not.*driver.*reclamation/i),
    ).toBeVisible();
    h.read.mockReturnValue({
      ...initial,
      screen: 'error',
      frame: { rendered: 27, steps: 9, profiled: 3 },
    });
    act(() => h.store.dispatch({ type: 'OPEN_COURSE_SELECT' }));
    view.rerender(<DiagnosticsDialog host={h.host} onClose={h.onClose} />);
    vi.useFakeTimers();
    try {
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(h.read).toHaveBeenCalledOnce();
    expect(controls.queryByText('27')).not.toBeInTheDocument();
    await userEvent.click(
      controls.getByRole('button', { name: 'Refresh snapshot' }),
    );
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(controls.getByText('27')).toBeVisible();
    expect(controls.getByText('error')).toBeVisible();
  });

  it('formats only safe summaries, names selected quality/backing pixels, and distinguishes active/pending owners', () => {
    const h = setup();
    const metrics = createFrameMetrics();
    metrics.record(16.12345, 2.126, 0);
    const initial = h.host.getDiagnostics();
    h.read.mockReturnValue({
      ...initial,
      selectedQuality: 'low',
      graphicsLost: true,
      backingPixels: { width: 480, height: 270 },
      resources: {
        canvases: 1,
        rafChains: 0,
        pendingCleanup: 2,
        scene: {
          lifecycle: 'active',
          bodies: 3,
          colliders: 13,
          geometries: 35,
          materials: 38,
        },
      },
      frameMetrics: metrics.getSnapshot(),
      cleanup: {
        pendingReleases: 2,
        constructionOwners: 1,
        failed: true,
        audioFailed: false,
      },
    });
    render(<DiagnosticsDialog host={h.host} onClose={h.onClose} />);
    expect(screen.getByText('480 x 270')).toBeVisible();
    expect(screen.getByText(/backing.*prior.*until.*restor/i)).toBeVisible();
    expect(screen.getByText('low')).toBeVisible();
    expect(screen.getByText('16.12 / 16.12 / 16.12')).toBeVisible();
    expect(screen.getByText('2.13 / 2.13 / 2.13')).toBeVisible();
    expect(screen.getByText('0.00 / 0.00 / 0.00')).toBeVisible();
    expect(screen.getByText('Pending release owners')).toBeVisible();
    expect(screen.getByText('Active scene owners')).toBeVisible();
    expect(screen.getByText('Shared audio')).toBeVisible();
  });

  it('owns Tab/Escape/cancel, restores focus on unmount and releases modal ownership without resuming', async () => {
    const h = setup();
    const ownership = vi.spyOn(h.host, 'setSettingsOpen');
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const view = render(
      <DiagnosticsDialog host={h.host} onClose={h.onClose} />,
    );
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Close diagnostics' });
    const refresh = screen.getByRole('button', { name: 'Refresh snapshot' });
    const before = h.store.getState();
    expect(ownership).toHaveBeenLastCalledWith(true);
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(refresh).toHaveFocus();
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.keyboard('[Escape]');
    expect(h.onClose).toHaveBeenCalledOnce();
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(h.onClose).toHaveBeenCalledTimes(2);
    expect(h.read).toHaveBeenCalledOnce();
    view.unmount();
    expect(ownership).toHaveBeenLastCalledWith(false);
    expect(opener).toHaveFocus();
    expect(h.store.getState()).toBe(before);
    opener.remove();
  });
});
