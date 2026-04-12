import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router-dom";

import styles from "./App.module.css";
import { ShowsTopBarSearch } from "./components/ShowsTopBarSearch";
import { ShowsSearchProvider } from "./contexts/showsSearch";
import { EpisodePage } from "./routes/episode";
import { FeedPage } from "./routes/feed";
import { HomePage } from "./routes/index";
import { ReportPage } from "./routes/report";
import { ShowsPage } from "./routes/shows";

function AppHeader() {
  const location = useLocation();
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <Link className={styles.brand} to="/" viewTransition>
          <span className={styles.brandMark}>P</span>
          <span className={styles.brandName}>podads</span>
        </Link>
        <ShowsTopBarSearch key={location.pathname} />
        <nav className={styles.nav}>
          <Link className={styles.navLink} to="/" viewTransition>
            Home
          </Link>
          <Link className={styles.navLink} to="/shows" viewTransition>
            Shows
          </Link>
        </nav>
      </div>
    </header>
  );
}

function App() {
  return (
    <BrowserRouter>
      <ShowsSearchProvider>
        <div className={styles.shell}>
          <AppHeader />

          <main className={styles.main}>
            <Routes>
              <Route element={<HomePage />} path="/" />
              <Route element={<ShowsPage />} path="/shows" />
              <Route element={<ReportPage />} path="/report" />
              <Route element={<EpisodePage />} path="/:slug/episodes/:episodeId" />
              <Route element={<FeedPage />} path="/:slug" />
              <Route element={<Navigate replace to="/" />} path="*" />
            </Routes>
          </main>
        </div>
      </ShowsSearchProvider>
    </BrowserRouter>
  );
}

export default App;
