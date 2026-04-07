import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";

import styles from "./App.module.css";
import { FeedPage } from "./routes/feed";
import { HomePage } from "./routes/index";
import { ReportPage } from "./routes/report";

function App() {
  return (
    <BrowserRouter>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.headerInner}>
            <Link className={styles.brand} to="/">
              <span className={styles.brandMark}>P</span>
              <span>podads</span>
            </Link>
            <nav className={styles.nav}>
              <Link to="/">Home</Link>
              <Link to="/report">Report</Link>
            </nav>
          </div>
        </header>

        <main className={styles.main}>
          <Routes>
            <Route element={<HomePage />} path="/" />
            <Route element={<ReportPage />} path="/report" />
            <Route element={<FeedPage />} path="/:slug" />
            <Route element={<Navigate replace to="/" />} path="*" />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
