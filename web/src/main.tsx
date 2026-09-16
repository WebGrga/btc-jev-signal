import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/outfit";
import { FluentProvider, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

function Root(): React.JSX.Element {
  const themeOverride = new URLSearchParams(window.location.search).get("theme");
  const [dark, setDark] = useState(() =>
    themeOverride === "dark" ||
    (themeOverride !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches),
  );

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  useEffect(() => {
    if (themeOverride === "dark" || themeOverride === "light") return undefined;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (event: MediaQueryListEvent) => setDark(event.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [themeOverride]);

  return (
    <FluentProvider theme={dark ? webDarkTheme : webLightTheme}>
      <App />
    </FluentProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
