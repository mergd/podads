import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { useShowsSearch } from "../contexts/showsSearch";
import { lastUpdatedLabel } from "../lib/dates";
import { decodeEntities } from "../lib/entities";
import styles from "./ShowsTopBarSearch.module.css";

const DROPDOWN_MAX = 12;

export function ShowsTopBarSearch() {
  const location = useLocation();
  const isShowsPage = location.pathname === "/shows";
  const { query, setQuery, isLoading, hasLoaded, feeds, total } = useShowsSearch();
  const [panelOpen, setPanelOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const showOffPagePanel = !isShowsPage && panelOpen;
  const hasQueryTrim = query.trim().length > 0;
  const dropdownFeeds = feeds.slice(0, DROPDOWN_MAX);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget;
      if (next && el.contains(next as Node)) return;
      setPanelOpen(false);
    };
    el.addEventListener("focusout", onFocusOut);
    return () => el.removeEventListener("focusout", onFocusOut);
  }, []);

  useEffect(() => {
    if (!showOffPagePanel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanelOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showOffPagePanel]);

  return (
    <div className={styles.wrap} ref={rootRef}>
      <input
        aria-autocomplete={isShowsPage ? undefined : "list"}
        aria-controls={showOffPagePanel ? listId : undefined}
        aria-expanded={!isShowsPage ? panelOpen : undefined}
        aria-label="Search shows"
        className={styles.search}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => {
          if (!isShowsPage) setPanelOpen(true);
        }}
        placeholder="Search shows…"
        role={isShowsPage ? undefined : "combobox"}
        type="search"
        value={query}
      />
      {isLoading && hasLoaded ? <div aria-hidden className={styles.spinner} /> : null}

      {showOffPagePanel ? (
        <div
          aria-label="Search results"
          className={styles.panel}
          id={listId}
          role="region"
        >
          {!hasQueryTrim ? (
            <div className={styles.panelHint}>
              <p className={styles.hintText}>Type to find a show, or browse the full directory.</p>
              <Link className={styles.browseAll} to="/shows" viewTransition>
                View all shows
              </Link>
            </div>
          ) : !hasLoaded && isLoading ? (
            <div className={styles.panelStatus}>Loading…</div>
          ) : hasQueryTrim && isLoading ? (
            <div className={styles.panelStatus}>Searching…</div>
          ) : feeds.length === 0 ? (
            <div className={styles.panelStatus}>No shows match “{query.trim()}”</div>
          ) : (
            <ul className={styles.resultList}>
              {dropdownFeeds.map((feed) => (
                <li key={feed.slug}>
                  <Link
                    className={styles.resultRow}
                    state={{ title: feed.title, imageUrl: feed.imageUrl }}
                    to={`/${feed.slug}`}
                    viewTransition
                  >
                    <div className={styles.resultArt}>
                      {feed.imageUrl ? (
                        <img alt="" className={styles.resultImg} loading="lazy" src={feed.imageUrl} />
                      ) : (
                        <span className={styles.resultArtFallback}>
                          {decodeEntities(feed.title ?? "P").charAt(0)}
                        </span>
                      )}
                    </div>
                    <div className={styles.resultBody}>
                      <span className={styles.resultTitle}>{decodeEntities(feed.title)}</span>
                      <span className={styles.resultMeta}>
                        {feed.author ? <span>{feed.author}</span> : null}
                        {feed.author ? <span aria-hidden className={styles.metaSep}>
                          ·
                        </span> : null}
                        <span>
                          {feed.episodeCount} ep{feed.episodeCount !== 1 ? "s" : ""}
                        </span>
                        {feed.latestEpisodePubDate ? (
                          <>
                            <span aria-hidden className={styles.metaSep}>
                              ·
                            </span>
                            <span>{lastUpdatedLabel(feed.latestEpisodePubDate)}</span>
                          </>
                        ) : null}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {total > DROPDOWN_MAX && hasQueryTrim ? (
            <div className={styles.panelFooter}>
              <Link className={styles.moreLink} to="/shows" viewTransition>
                See all {total} matches on Shows
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
