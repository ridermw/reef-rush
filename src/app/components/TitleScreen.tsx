const controls = [
  { input: 'WASD / Arrow keys', action: 'Steer and pitch through the course' },
  { input: 'Space', action: 'Trigger boost pickups' },
  { input: 'Left Shift', action: 'Feather speed for tight corners' },
  { input: 'R', action: 'Restart the current run' },
  { input: 'Esc', action: 'Pause' },
];

export interface TitleScreenProps {
  onDiveIn: () => void;
}

export function TitleScreen({ onDiveIn }: TitleScreenProps) {
  return (
    <main className="screen screen--title">
      <section className="hero-panel">
        <p className="eyebrow">Solo time-trial prototype</p>
        <div className="hero-copy">
          <div>
            <p className="wordmark-kicker">Chart the clean line</p>
            <h1 className="wordmark">Reef Rush</h1>
          </div>
          <p className="hero-pitch">
            Chase flawless underwater racing lines across handcrafted solo
            courses built for fast restarts and confident improvement.
          </p>
        </div>
        <div className="hero-actions">
          <button className="primary-button" onClick={onDiveIn} type="button">
            Dive in
          </button>
          <p className="hero-meta">
            Static shell today, frame-by-frame game runtime to follow.
          </p>
        </div>
      </section>

      <section aria-labelledby="controls-heading" className="info-panel">
        <div className="panel-heading">
          <h2 id="controls-heading">Controls at a glance</h2>
          <p>
            Keep the shell focused on launch flow, readability, and fast
            retries.
          </p>
        </div>
        <dl className="controls-grid">
          {controls.map((control) => (
            <div className="controls-row" key={control.input}>
              <dt>{control.input}</dt>
              <dd>{control.action}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}
