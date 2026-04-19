import { MagnifyingGlass } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { useShowsSearch, type ShowSearchItem } from "../contexts/showsSearch";
import { lastUpdatedLabel } from "../lib/dates";
import { decodeEntities } from "../lib/entities";
import styles from "./ShowsTopBarSearch.module.css";

const DROPDOWN_MAX = 12;

function itemTitle(item: ShowSearchItem): string {
  return item.feed?.title ?? item.itunes?.title ?? "Untitled podcast";
}

function itemAuthor(item: ShowSearchItem): string | null {
  return item.feed?.author ?? item.itunes?.author ?? null;
}

function itemImage(item: ShowSearchItem): string | null {
  return item.feed?.imageUrl ?? item.itunes?.artworkUrl ?? null;
}

export function ShowsTopBarSearch() {
  const location = useLocation();
  const navigate = useNavigate();
  const isShowsPage = location.pathname === "/shows";
  const { query, setQuery, isLoading, hasLoaded, items, total, importItem, importingKey } = useShowsSearch();
  const [panelOpen, setPanelOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const showOffPagePanel = !isShowsPage && panelOpen;
  const hasQueryTrim = query.trim().length > 0;
  const dropdownItems = items.slice(0, DROPDOWN_MAX);

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

  const handleImport = async (item: ShowSearchItem) => {
    try {
      const feed = await importItem(item);
      setPanelOpen(false);
      navigate(`/${feed.slug}`, { state: { title: feed.title, imageUrl: feed.imageUrl } });
    } catch {
      // swallow; context keeps state
    }
  };

  return (
    <div className={styles.wrap} ref={rootRef}>
      <form
        action="/shows"
        className={styles.field}
        onSubmit={(e) => {
          e.preventDefault();
          setPanelOpen(false);
          inputRef.current?.blur();
          if (!isShowsPage) navigate("/shows");
        }}
        role="search"
      >
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
          ref={inputRef}
          role={isShowsPage ? undefined : "combobox"}
          type="search"
          value={query}
        />
        {isLoading && hasLoaded ? <div aria-hidden className={styles.spinner} /> : null}
        <button
          aria-label="Search shows"
          className={styles.searchButton}
          type="submit"
        >
          <MagnifyingGlass aria-hidden size={16} weight="bold" />
        </button>
      </form>

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
          ) : items.length === 0 ? (
            <div className={styles.panelStatus}>No shows match “{query.trim()}”</div>
          ) : (
            <ul className={styles.resultList}>
              {dropdownItems.map((item) => {
                const title = itemTitle(item);
                const author = itemAuthor(item);
                const image = itemImage(item);
                const isImporting = importingKey === item.key;

                const art = (
                  <div className={styles.resultArt}>
                    {image ? (
                      <img alt="" className={styles.resultImg} loading="lazy" src={image} />
                    ) : (
                      <span className={styles.resultArtFallback}>
                        {decodeEntities(title).charAt(0)}
                      </span>
                    )}
                  </div>
                );

                const body = (
                  <div className={styles.resultBody}>
                    <span className={styles.resultTitle}>{decodeEntities(title)}</span>
                    <span className={styles.resultMeta}>
                      {author ? <span>{author}</span> : null}
                      {item.feed ? (
                        <>
                          {author ? <span aria-hidden className={styles.metaSep}>·</span> : null}
                          <span>
                            {item.feed.episodeCount} ep{item.feed.episodeCount !== 1 ? "s" : ""}
                          </span>
                          {item.feed.latestEpisodePubDate ? (
                            <>
                              <span aria-hidden className={styles.metaSep}>·</span>
                              <span>{lastUpdatedLabel(item.feed.latestEpisodePubDate)}</span>
                            </>
                          ) : null}
                        </>
                      ) : item.itunes?.trackCount ? (
                        <>
                          {author ? <span aria-hidden className={styles.metaSep}>·</span> : null}
                          <span>{item.itunes.trackCount} ep{item.itunes.trackCount !== 1 ? "s" : ""}</span>
                        </>
                      ) : null}
                    </span>
                  </div>
                );

                if (item.feed) {
                  return (
                    <li key={item.key}>
                      <Link
                        className={styles.resultRow}
                        state={{ title: item.feed.title, imageUrl: item.feed.imageUrl }}
                        to={`/${item.feed.slug}`}
                        viewTransition
                      >
                        {art}
                        {body}
                      </Link>
                    </li>
                  );
                }

                return (
                  <li key={item.key}>
                    <button
                      className={styles.resultRow}
                      disabled={isImporting}
                      onClick={() => void handleImport(item)}
                      type="button"
                    >
                      {art}
                      {body}
                      <span className={styles.importTag}>{isImporting ? "Importing…" : "Import"}</span>
                    </button>
                  </li>
                );
              })}
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
