const dataPoints = [
  "League settings and scoring rules",
  "Team rosters and available players",
  "Draft results and league transactions",
  "Standings, matchups, and weekly results",
];

const principles = [
  ["One manager", "Built for a single owner in one private, long-running league."],
  ["Least privilege", "Read-only access to the minimum Yahoo Fantasy data needed for decisions."],
  ["No redistribution", "Yahoo data will not be sold, syndicated, or published for other users."],
  ["Owner controlled", "The system advises; the account owner remains responsible for every decision."],
];

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="SKRODZKai home">
          SKRODZK<span>AI</span>
        </a>
        <div className="status"><i /> Private project</div>
      </header>

      <section className="hero" id="top">
        <p className="eyebrow">Fantasy Football General Manager</p>
        <h1>One league.<br />Twenty seasons of context.</h1>
        <p className="lede">
          SKRODZKai Fantasy Football GM is a private, single-user decision-support
          system for managing one Yahoo Fantasy Football team with better preparation,
          clearer probabilities, and disciplined weekly decisions.
        </p>
        <div className="facts" aria-label="Project facts">
          <span>Personal use only</span>
          <span>1 expected user</span>
          <span>No commercial resale</span>
        </div>
      </section>

      <section className="purpose" aria-labelledby="purpose-title">
        <p className="section-number">01 / Purpose</p>
        <div>
          <h2 id="purpose-title">Turn league context into better decisions.</h2>
          <p>
            The application combines league-specific rules and current team state with
            independently sourced football research. It supports draft preparation,
            player rankings, lineup choices, waiver analysis, and performance review.
          </p>
        </div>
      </section>

      <section className="data-section" aria-labelledby="data-title">
        <div className="section-heading">
          <p className="section-number">02 / Yahoo data requested</p>
          <h2 id="data-title">Only what the league requires.</h2>
        </div>
        <ul className="data-list">
          {dataPoints.map((item, index) => (
            <li key={item}><span>0{index + 1}</span>{item}</li>
          ))}
        </ul>
      </section>

      <section className="principles" aria-labelledby="principles-title">
        <div className="section-heading">
          <p className="section-number">03 / Operating principles</p>
          <h2 id="principles-title">Small scope. Clear boundaries.</h2>
        </div>
        <div className="principle-grid">
          {principles.map(([title, body]) => (
            <article key={title}>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="privacy" aria-labelledby="privacy-title">
        <p className="section-number">04 / Data posture</p>
        <div>
          <h2 id="privacy-title">Private by design.</h2>
          <p>
            Yahoo Fantasy data is used solely to provide personal decision support to
            the account owner. The project will follow Yahoo&apos;s access, attribution,
            security, and retention requirements and will not create a public fantasy
            data product or competing service.
          </p>
        </div>
      </section>

      <footer>
        <p>SKRODZKai Fantasy Football GM</p>
        <p>Private single-user application · 2026</p>
      </footer>
    </main>
  );
}
