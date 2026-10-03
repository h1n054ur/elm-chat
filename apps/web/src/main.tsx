import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { FOCUS_RING, TopRule } from "./LimitsPage";
import "./theme.css";

type RootBoundaryState = {
  error: Error | null;
};

class RootBoundary extends React.Component<React.PropsWithChildren, RootBoundaryState> {
  state: RootBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RootBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error("chat render crash", error);
  }

  render() {
    if (this.state.error) {
      return (
        <>
          <TopRule />
          <main className="flex min-h-[calc(100dvh-2px)] items-center justify-center px-4 py-10" lang="en">
            <section aria-live="polite" className="box w-full max-w-md p-6 pt-7">
              <span className="box-title">error</span>
              <h1 className="text-xl font-bold tracking-tight">Could not open this session</h1>
              <p className="mt-3 text-sm leading-relaxed text-dim">
                The app hit a browser error while opening this room. Reload once. If it still fails,
                go back home and create a fresh invite.
              </p>
              <p className="error-text mt-3 break-words text-xs text-danger">{this.state.error.message}</p>
              <a className={`mt-6 inline-block rounded-sm text-sm text-acc hover:text-fg ${FOCUS_RING}`} href="/">
                <span aria-hidden="true">&larr; </span>
                back home
              </a>
            </section>
          </main>
        </>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootBoundary>
      <App />
    </RootBoundary>
  </React.StrictMode>
);
