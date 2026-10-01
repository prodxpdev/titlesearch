import { useEffect } from "react";
import { api } from "./api";
import { Nav, PreviewLayer, Toast } from "./components";
import { useRoute } from "./router";
import { setState, useStore } from "./store";
import { Connect } from "./views/Connect";
import { Domain } from "./views/Domain";
import { Login } from "./views/Login";
import { Providers } from "./views/Providers";
import { Results } from "./views/Results";
import { Search } from "./views/Search";
import { Shortlist } from "./views/Shortlist";

const TITLES: Record<string, string> = {
  search: "New search",
  results: "Results",
  shortlist: "Shortlist",
  providers: "Providers",
  connect: "Connect Claude",
};

export function App() {
  const route = useRoute();
  const authenticated = useStore((s) => s.authenticated);

  useEffect(() => {
    api
      .session()
      .then((r) => setState({ authenticated: r.authenticated, login: r.login ?? "code" }))
      .catch(() => setState({ authenticated: false }));
  }, []);
  useEffect(() => {
    document.title = `Titlesearch — ${route.name === "domain" ? route.domain : TITLES[route.name]}`;
    window.scrollTo(0, 0);
  }, [route]);

  let view: React.ReactNode;
  if (authenticated === undefined) view = null;
  else if (!authenticated) view = <Login />;
  else if (route.name === "results") view = <Results />;
  else if (route.name === "domain") view = <Domain domain={route.domain} />;
  else if (route.name === "shortlist") view = <Shortlist />;
  else if (route.name === "providers") view = <Providers />;
  else if (route.name === "connect") view = <Connect />;
  else view = <Search />;

  return (
    <>
      <Nav route={route} />
      <div id="view">{view}</div>
      <PreviewLayer />
      <Toast />
    </>
  );
}
