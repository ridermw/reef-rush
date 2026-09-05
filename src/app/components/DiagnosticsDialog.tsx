import { useState, type ReactNode } from 'react';
import type { GameHost } from '../../game/core/GameHost';
import type { FrameSummary } from '../../game/core/frameMetrics';
import { NativeDialog } from './NativeDialog';

function Reading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function summary(value: FrameSummary | null): string {
  return value
    ? `${value.mean.toFixed(2)} / ${value.p95.toFixed(2)} / ${value.max.toFixed(2)}`
    : 'No running samples';
}

export function DiagnosticsDialog({
  host,
  onClose,
}: {
  host: Pick<GameHost, 'getDiagnostics' | 'setSettingsOpen'>;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState(() => host.getDiagnostics());
  const { frameMetrics, resources, audio, cleanup } = snapshot;
  return (
    <NativeDialog
      labelledBy="diagnostics-heading"
      describedBy="diagnostics-description"
      onClose={onClose}
      onModalChange={host.setSettingsOpen}
    >
      <header className="settings-header">
        <div>
          <p className="eyebrow">Under the surface</p>
          <h2 id="diagnostics-heading">Diagnostics</h2>
        </div>
        <button className="secondary-button" type="button" onClick={onClose}>
          Close diagnostics
        </button>
      </header>
      <p id="diagnostics-description" className="settings-description">
        A local, manual snapshot. Nothing is sent. Values change only when you
        refresh. Closing never resumes your run.
      </p>
      <section
        className="diagnostics-group"
        aria-labelledby="diagnostics-runtime"
      >
        <h3 id="diagnostics-runtime">Runtime</h3>
        <dl className="diagnostics-readings">
          <Reading label="Screen">{snapshot.screen}</Reading>
          <Reading label="Lifecycle">{snapshot.lifecycle}</Reading>
          <Reading label="Graphics">
            {snapshot.graphicsLost
              ? 'Lost'
              : snapshot.backingPixels
                ? 'Available'
                : 'Not loaded'}
          </Reading>
          <Reading label="Selected quality">{snapshot.selectedQuality}</Reading>
          <Reading label="Backing pixels">
            {snapshot.backingPixels
              ? `${snapshot.backingPixels.width} x ${snapshot.backingPixels.height}`
              : 'No canvas'}
          </Reading>
        </dl>
        {snapshot.graphicsLost && (
          <p className="settings-description">
            While graphics are lost, backing pixels may reflect the prior
            quality until restoration.
          </p>
        )}
      </section>
      <section
        className="diagnostics-group"
        aria-labelledby="diagnostics-samples"
      >
        <h3 id="diagnostics-samples">Recent running samples</h3>
        <p className="settings-description">
          Mean / P95 / max in milliseconds, rounded to 2 decimals. CPU work is
          synchronous simulation, presentation and render submission, not GPU
          time or all browser work. Paused frames are excluded.
        </p>
        <dl className="diagnostics-readings">
          <Reading label="Running samples">
            {frameMetrics.sampleCount} / {frameMetrics.capacity}
          </Reading>
          <Reading label="Frame interval (ms)">
            {summary(frameMetrics.intervalMs)}
          </Reading>
          <Reading label="CPU work (ms)">
            {summary(frameMetrics.cpuWorkMs)}
          </Reading>
          <Reading label="Discarded time (ms)">
            {summary(frameMetrics.droppedMs)}
          </Reading>
          <Reading label="Dropped-time samples">
            {frameMetrics.droppedSampleCount}
          </Reading>
          <Reading label="Rendered frames">{snapshot.frame.rendered}</Reading>
          <Reading label="Simulation steps">{snapshot.frame.steps}</Reading>
          <Reading label="Profiled frames">{snapshot.frame.profiled}</Reading>
        </dl>
        <p className="settings-description">
          Last {frameMetrics.capacity} qualifying frames; reset on a fresh load
          or changed quality. Profiled frames count qualifying records over this
          host&apos;s lifetime; rendered frames and steps restart on load.
        </p>
      </section>
      <section
        className="diagnostics-group"
        aria-labelledby="diagnostics-owners"
      >
        <h3 id="diagnostics-owners">Resource ownership</h3>
        <dl className="diagnostics-readings">
          <Reading label="Active scene owners">
            {resources.scene ? 1 : 0}
          </Reading>
          <Reading label="Bodies">{resources.scene?.bodies ?? 0}</Reading>
          <Reading label="Colliders">{resources.scene?.colliders ?? 0}</Reading>
          <Reading label="Geometries">
            {resources.scene?.geometries ?? 0}
          </Reading>
          <Reading label="Materials">{resources.scene?.materials ?? 0}</Reading>
          <Reading label="Attached canvases">{resources.canvases}</Reading>
          <Reading label="RAF chains">{resources.rafChains}</Reading>
          <Reading label="Pending release owners">
            {cleanup.pendingReleases}
          </Reading>
          <Reading label="Construction owners">
            {cleanup.constructionOwners}
          </Reading>
          <Reading label="Runtime cleanup">
            {cleanup.failed ? 'Needs retry' : 'Clear'}
          </Reading>
        </dl>
        <p className="settings-description">
          Active counts exclude retained pending owners. These are ownership
          counts, not GPU, heap or driver reclamation measurements.
        </p>
      </section>
      <section
        className="diagnostics-group"
        aria-labelledby="diagnostics-audio"
      >
        <h3 id="diagnostics-audio">Shared audio</h3>
        <dl className="diagnostics-readings">
          <Reading label="Audio status">
            {audio.status} / {audio.phase}
          </Reading>
          <Reading label="Owned context">
            {audio.ownsContext ? 'Yes' : 'No'} / {audio.contextState ?? 'None'}
          </Reading>
          <Reading label="Owned audio nodes">{audio.ownedNodes}</Reading>
          <Reading label="Active effects / ambience">
            {audio.activeEffects} / {audio.activeAmbience}
          </Reading>
          <Reading label="Pending audio unlock">
            {audio.pendingUnlock ? 'Yes' : 'No'}
          </Reading>
          <Reading label="Audio cleanup">
            {audio.pendingCleanup || cleanup.audioFailed ? 'Pending' : 'Clear'}
          </Reading>
        </dl>
        <p className="settings-description">
          The host may keep its shared audio context on title. Detailed recovery
          messages remain in the game&apos;s error and audio notices.
        </p>
      </section>
      <button
        className="secondary-button"
        type="button"
        onClick={() => setSnapshot(host.getDiagnostics())}
      >
        Refresh snapshot
      </button>
    </NativeDialog>
  );
}
