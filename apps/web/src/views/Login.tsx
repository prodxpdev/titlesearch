import { useState } from "react";
import { ApiError, api } from "../api";
import { Band } from "../components";
import { setState } from "../store";

export function Login() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  return (
    <>
      <Band
        title="Sign in"
        text="Enter the code that titlesearch serve printed in your terminal."
      />
      <main>
        <form
          className="panel login"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(undefined);
            try {
              await api.signIn(code);
              setState({ authenticated: true });
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Couldn't sign in.");
            }
          }}
        >
          <label className="f" htmlFor="code">
            Sign-in code
          </label>
          <input
            id="code"
            type="text"
            autoComplete="one-time-code"
            spellCheck={false}
            value={code}
            maxLength={16}
            onChange={(e) => setCode(e.target.value)}
          />
          <p className="hint">
            Codes work once and expire after 5 minutes. Press Enter in the terminal for a new one.
          </p>
          {error && (
            <p className="err" role="alert">
              {error}
            </p>
          )}
          <div className="row-actions">
            <button className="btn primary" type="submit" disabled={code.trim().length < 6}>
              Sign in
            </button>
          </div>
        </form>
      </main>
    </>
  );
}
