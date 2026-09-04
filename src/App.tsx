const plannedCourses = [
  {
    name: 'Kelpway Sprint',
    description:
      'A quick beginner circuit that teaches drifting, boost timing, and clean gates.',
  },
  {
    name: 'Coral Slalom',
    description:
      'A denser reef route built around sharp turns, shortcuts, and recovery lines.',
  },
  {
    name: 'Trench Gauntlet',
    description:
      'A late-game descent that layers hazards, verticality, and leaderboard pace.',
  },
];

const controls = [
  'WASD or Arrow keys to steer',
  'Space to trigger boost pickups',
  'Left Shift to feather speed through tight turns',
  'R to restart the run',
  'Esc to pause',
];

export default function App() {
  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Prototype foundation</p>
        <h1>Reef Rush</h1>
        <p className="lede">
          A polished underwater time-trial arcade game for the browser, built
          for short reruns, clean racing lines, and leaderboard-perfect
          restarts.
        </p>
      </section>

      <section className="panel">
        <h2>Target release slice</h2>
        <p>
          The initial public roadmap focuses on three replayable courses that
          escalate from a welcoming reef sprint to a high-pressure trench
          finale.
        </p>
        <div className="course-grid">
          {plannedCourses.map((course) => (
            <article key={course.name} className="card">
              <h3>{course.name}</h3>
              <p>{course.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Desktop controls</h2>
        <ul className="control-list">
          {controls.map((control) => (
            <li key={control}>{control}</li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Technical baseline</h2>
        <p>
          Vite drives the web build, React owns the shell and UI composition,
          Three.js will render the underwater world, Rapier will handle
          collision and movement simulation, and Zod will validate
          runtime-facing config as the project grows.
        </p>
      </section>
    </main>
  );
}
