import { Band } from "../components";
import { LABEL, priceOf, statusOf } from "../labels";
import { copyForClaude } from "../markdown";
import { setState, toast, useStore } from "../store";

const CORE = ["io", "app", "dev"];

export function Shortlist() {
  const { rows, shortlist, searchedTlds: tlds, searchedMarket } = useStore((s) => s);
  const names = rows.filter((r) => shortlist[r.name]);
  if (names.length === 0) {
    return (
      <>
        <Band title="Shortlist" />
        <main>
          <div className="panel empty">
            <p>Your shortlist is empty.</p>
            <a className="btn primary" href="#/results">
              Add names from results
            </a>
          </div>
        </main>
      </>
    );
  }
  return (
    <>
      <Band
        title="Shortlist"
        text={`${names.length} name${names.length === 1 ? "" : "s"} to decide between.`}
        extra={
          <button
            type="button"
            className="btn"
            onClick={() =>
              void copyForClaude(names, tlds, searchedMarket).then(() =>
                toast("Copied shortlist for Claude"),
              )
            }
          >
            Copy for Claude
          </button>
        }
      />
      <main>
        <div className="panel">
          <div className="t-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>.com</th>
                  <th>Open extensions</th>
                  <th>Competitors or overlap</th>
                  <th>Open core set, first year</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {names.map((row) => {
                  const by = (t: string) =>
                    row.results.find((r) => r.domain === `${row.name}.${t}`);
                  const open = tlds.filter(
                    (t) => by(t)?.availability === "available" || by(t)?.availability === "premium",
                  );
                  const conflicts = tlds.filter((t) =>
                    ["competitor", "possible_overlap"].includes(by(t)?.occupancy ?? ""),
                  );
                  const com = by("com");
                  const core = CORE.filter((t) => open.includes(t));
                  const prices = core.map((t) => {
                    const r = by(t);
                    return r ? priceOf(r) : undefined;
                  });
                  const allPriced = prices.length > 0 && prices.every(Boolean);
                  const total = allPriced
                    ? core.reduce((sum, t) => {
                        const src = by(t)?.sources.find((s) => s.price);
                        return sum + (src?.price?.amount ?? 0);
                      }, 0)
                    : 0;
                  return (
                    <tr key={row.name}>
                      <td>
                        <a
                          className="dn"
                          href={`#/domain/${encodeURIComponent(`${row.name}.com`)}`}
                        >
                          {row.name}
                        </a>
                      </td>
                      <td>{com ? LABEL[statusOf(com)] : "Not checked"}</td>
                      <td>{open.length ? open.map((t) => `.${t}`).join(", ") : "None"}</td>
                      <td>
                        {conflicts.length ? conflicts.map((t) => `.${t}`).join(", ") : "None found"}
                      </td>
                      <td>
                        {core.length === 0
                          ? "None open"
                          : allPriced
                            ? `$${total.toFixed(2)}`
                            : "No price from this source"}
                        <br />
                        <span className="hint" style={{ margin: 0 }}>
                          {core.map((t) => `.${t}`).join(" + ")}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn"
                          aria-pressed="true"
                          onClick={() => {
                            setState((s) => ({ shortlist: { ...s.shortlist, [row.name]: false } }));
                            toast(`Removed ${row.name} from shortlist`);
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <h2>Before you buy</h2>
          <p className="sub" style={{ margin: 0 }}>
            Market overlap looks at live websites only. Search the USPTO trademark database, and
            your target countries' registers, for every name you plan to use.
          </p>
        </div>
      </main>
    </>
  );
}
