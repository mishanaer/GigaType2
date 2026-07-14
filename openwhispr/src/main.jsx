import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import AppRouter from "./AppRouter.jsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";
import { ToastProvider } from "./components/ui/Toast.tsx";
import { SettingsProvider } from "./hooks/useSettings";
import { getCachedPlatform } from "./utils/platform";

import i18n from "./i18n";
import "./index.css";

const platform = getCachedPlatform();
document.documentElement.dataset.platform = platform;

// Linux follows the system theme. Apply it before React's first paint so the
// semantic muted canvas matches the native BrowserWindow background.
if (platform === "linux" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
  document.documentElement.classList.add("dark");
  document.body.classList.add("dark");
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nextProvider i18n={i18n}>
        <SettingsProvider>
          <ToastProvider>
            <AppRouter />
          </ToastProvider>
        </SettingsProvider>
      </I18nextProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

if (import.meta.hot) {
  import.meta.hot.accept();
}
