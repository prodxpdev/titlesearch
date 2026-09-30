import { Band } from "../components";
import { go } from "../router";
import { runSearch } from "../search";
import { setState, TLD_CHOICES, useStore } from "../store";

export function Search() {
  const { names, market, tlds, variants } = useStore((s) => s);
  const canRun = names.trim().length > 0 && Object.values(tlds).some(Boolean);
  return (
    <>
      <Band
        title="Is the name free, and who lives next door?"
        text="Check each name across the extensions you care about, then see what's already running on the ones that are taken."
      />
      <main>
        <form
          className="grid3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canRun) return;
            go("#/results");
            void runSearch();
          }}
        >
          <div className="panel">
            <div className="field">
              <label className="f" htmlFor="names">
                Name ideas
              </label>
              <textarea
                id="names"
                spellCheck={false}
                value={names}
                placeholder={"fieldloom\ncrewcadence"}
                onChange={(e) => setState({ names: e.target.value })}
              />
              <p className="hint">One per line. Leave off the extension.</p>
            </div>
            <div className="field">
              <label className="f" htmlFor="market">
                What are you building?
              </label>
              <input
                type="text"
                id="market"
                value={market}
                maxLength={1000}
                placeholder="Scheduling and dispatch software for small field-service contractors"
                onChange={(e) => setState({ market: e.target.value })}
              />
              <p className="hint">Used to judge whether sites on taken domains compete with you.</p>
            </div>
            <div className="field">
              <span className="f" id="tldl">
                Extensions
              </span>
              <fieldset
                className="chips"
                aria-labelledby="tldl"
                style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
              >
                {TLD_CHOICES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="chip"
                    aria-pressed={!!tlds[t]}
                    onClick={() => setState((s) => ({ tlds: { ...s.tlds, [t]: !s.tlds[t] } }))}
                  >
                    .{t}
                  </button>
                ))}
              </fieldset>
            </div>
            <div className="row-actions">
              <button className="btn primary" type="submit" disabled={!canRun}>
                Run search
              </button>
            </div>
          </div>
          <div className="panel">
            <h2>Also try</h2>
            <p className="sub">Adds variations of each name to the search.</p>
            {(
              [
                ["prefix", "Prefixes", "get, try, use"],
                ["suffix", "Suffixes", "hq, app, labs"],
                ["plural", "Plural and singular", ""],
              ] as const
            ).map(([k, label, hint]) => (
              <label className="check" key={k}>
                <input
                  type="checkbox"
                  checked={variants[k]}
                  onChange={(e) =>
                    setState((s) => ({ variants: { ...s.variants, [k]: e.target.checked } }))
                  }
                />{" "}
                <span>
                  <b>{label}</b>
                  {hint && (
                    <>
                      <br />
                      <span className="hint" style={{ margin: 0 }}>
                        {hint}
                      </span>
                    </>
                  )}
                </span>
              </label>
            ))}
            <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "20px 0" }} />
            <h2>Sources</h2>
            <p className="sub" style={{ marginBottom: 8 }}>
              Registry records from RDAP. Availability from GoDaddy.
            </p>
            <a href="#/providers">Change providers</a>
          </div>
        </form>
      </main>
    </>
  );
}
