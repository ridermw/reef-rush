const controls = [
  { input: 'W / S', action: 'Throttle: increase / reduce forward speed' },
  { input: 'A / D or Left / Right', action: 'Steer horizontally' },
  {
    input: 'Up / Down or mouse',
    action: 'Pitch; mouse also steers horizontally',
  },
  { input: 'Space', action: 'Dash using boost reserve' },
  { input: 'Left Shift', action: 'Feather speed for tight corners' },
  { input: 'Esc', action: 'Pause / resume' },
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
            Chase underwater racing lines through generated Sunlit Shoals. Pass
            every checkpoint, collect pearls, and race for a medal.
          </p>
        </div>
        <div className="hero-actions">
          <button className="primary-button" onClick={onDiveIn} type="button">
            Dive in
          </button>
          <p className="hero-meta">
            Desktop keyboard and mouse. More courses are in development.
          </p>
        </div>
      </section>

      <section aria-labelledby="controls-heading" className="info-panel">
        <div className="panel-heading">
          <h2 id="controls-heading">Controls at a glance</h2>
          <p>
            Move the pointer over the water to steer. Leaving the window pauses
            the run.
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
