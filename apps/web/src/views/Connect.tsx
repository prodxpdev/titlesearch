import { useRef, useState } from "react";
import { api } from "../api";
import { Band, Kv } from "../components";
import { toast } from "../store";

const TOOLS: [string, string][] = [
  ["check_domains", "Checks names across extensions and returns availability and price."],
  [
    "inspect_domain",
    "Reports what's running on one domain: registry record, connection, page details, and a preview.",
  ],
  [
    "assess_market_conflicts",
    "Gathers evidence on every taken extension for a name, for Claude to judge against your market.",
  ],
  ["generate_variants", "Builds prefix, suffix, and extension variations of a name."],
];

export function Connect() {
  const [tab, setTab] = useState<"desktop" | "code" | "remote">("desktop");
  const [newToken, setNewToken] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);
  const origin = window.location.origin;
  const snippets = {
    desktop:
      '{\n  "mcpServers": {\n    "titlesearch": {\n      "command": "titlesearch",\n      "args": ["mcp"]\n    }\n  }\n}',
    code: "claude mcp add titlesearch -- titlesearch mcp",
    remote: "https://titlesearch.your-company.com/mcp",
  };
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  };
  return (
    <>
      <Band
        title="Use Titlesearch from Claude"
        text="Ask Claude to brainstorm names for a product and check them as it goes."
      />
      <main>
        <div className="grid3">
          <div className="panel">
            <div className="tabs" role="tablist">
              {(
                [
                  ["desktop", "Claude Desktop"],
                  ["code", "Claude Code"],
                  ["remote", "Your own server"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  onClick={() => setTab(k)}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="sub">
              {tab === "desktop"
                ? "Add this to your Claude Desktop config file, then restart Claude."
                : tab === "code"
                  ? "Run this in your terminal."
                  : "For a copy you deployed to Cloud Run, Cloudflare Workers, or AWS. Add it in Claude as a custom connector and sign in when prompted."}
            </p>
            <pre className="code">{snippets[tab]}</pre>
            <div className="row-actions">
              <button type="button" className="btn" onClick={() => void copy(snippets[tab])}>
                {tab === "desktop" ? "Copy config" : tab === "code" ? "Copy command" : "Copy URL"}
              </button>
            </div>
            {tab === "remote" && (
              <p className="hint">Sign-in uses the identity provider you set up at deploy time.</p>
            )}
          </div>
          <div className="panel">
            <h2>What Claude can do</h2>
            <p className="sub">Read-only. Claude can check and compare names, never buy them.</p>
            <table className="t">
              <tbody>
                {TOOLS.map(([name, text]) => (
                  <tr key={name}>
                    <td className="dn" style={{ fontSize: 14, whiteSpace: "nowrap" }}>
                      {name}
                    </td>
                    <td>{text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint" style={{ marginTop: 14 }}>
              Try: “Suggest ten names for a scheduling app for dance studios and check .com, .app,
              and .io for each.”
            </p>
          </div>
        </div>
        <div className="panel" style={{ marginTop: 16 }}>
          <h2>This computer</h2>
          <p className="sub">The app's local server, for other tools on this machine.</p>
          <Kv
            rows={[
              [
                "Address",
                <span key="address" className="dn" style={{ fontSize: 14 }}>
                  {origin}
                </span>,
              ],
              [
                "MCP endpoint",
                <span key="mcp" className="dn" style={{ fontSize: 14 }}>
                  {origin}/mcp
                </span>,
              ],
              [
                "Access token",
                <span key="token">
                  <span className="dn" style={{ fontSize: 14 }}>
                    ••••••••••••••••
                  </span>{" "}
                  <button
                    type="button"
                    className="btn"
                    style={{ padding: "4px 10px", marginLeft: 8 }}
                    onClick={async () => {
                      try {
                        setNewToken((await api.rotateToken()).token);
                        dialog.current?.showModal();
                      } catch {
                        toast("Couldn't replace the token.");
                      }
                    }}
                  >
                    Replace token
                  </button>
                </span>,
              ],
              ["Reachable from", "This computer only"],
            ]}
          />
        </div>
        <dialog
          className="pv"
          ref={dialog}
          aria-labelledby="tokTitle"
          onClose={() => setNewToken(undefined)}
          style={{ maxWidth: 560 }}
        >
          <div className="pv-head">
            <b id="tokTitle">New access token</b>
            <button type="button" className="x" onClick={() => dialog.current?.close()}>
              Close
            </button>
          </div>
          <div style={{ padding: 20 }}>
            <p className="sub">
              Update your other tools with this token now. It won't be shown again. The old token no
              longer works.
            </p>
            <div className="token-box">{newToken}</div>
            <div className="row-actions">
              <button
                type="button"
                className="btn primary"
                onClick={() => newToken && void copy(newToken)}
              >
                Copy token
              </button>
            </div>
          </div>
        </dialog>
      </main>
    </>
  );
}
