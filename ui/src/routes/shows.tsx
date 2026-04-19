import { Link, useNavigate } from "react-router-dom";

import { Skeleton } from "../components/Skeleton";
import { useShowsSearch, type ShowSearchItem } from "../contexts/showsSearch";
import { lastUpdatedLabel } from "../lib/dates";
import { decodeEntities } from "../lib/entities";
import styles from "./shows.module.css";

function itemTitle(item: ShowSearchItem): string {
  return item.feed?.title ?? item.itunes?.title ?? "Untitled podcast";
}

function itemAuthor(item: ShowSearchItem): string | null {
  return item.feed?.author ?? item.itunes?.author ?? null;
}

function itemImage(item: ShowSearchItem): string | null {
  return item.feed?.imageUrl ?? item.itunes?.artworkUrl ?? null;
}

export function ShowsPage() {
  const { items, total, hasLoaded, query, importItem, importingKey } = useShowsSearch();
  const navigate = useNavigate();

  const handleImport = async (item: ShowSearchItem) => {
    try {
      const feed = await importItem(item);
      navigate(`/${feed.slug}`, { state: { title: feed.title, imageUrl: feed.imageUrl } });
    } catch {
      // keep the user on the page; context preserves state
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Shows</h1>
          <span className={styles.count}>{total}</span>
        </div>
      </div>

      {!hasLoaded ? (
        <div className={styles.grid}>
          {Array.from({ length: 8 }, (_, i) => (
            <div className={styles.skeletonCard} key={i}>
              <Skeleton variant="rounded" width="100%" height={0} className={styles.skeletonArt} />
              <div className={styles.info}>
                <Skeleton width="80%" height={14} />
                <Skeleton width="50%" height={10} />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className={styles.empty}>
          {query ? (
            <p className={styles.emptyTitle}>No shows matching &ldquo;{query}&rdquo; on Apple Podcasts</p>
          ) : (
            "No shows registered yet. Register a feed from the home page."
          )}
        </div>
      ) : (
        <div className={styles.grid}>
          {items.map((item) => {
            const title = decodeEntities(itemTitle(item));
            const author = itemAuthor(item);
            const image = itemImage(item);
            const fallbackLetter = title.charAt(0);

            const art = (
              <div
                className={styles.artWrap}
                style={item.feed ? { viewTransitionName: `feed-art-${item.feed.slug}` } : undefined}
              >
                {image ? (
                  <img alt="" className={styles.art} loading="lazy" src={image} />
                ) : (
                  <div className={styles.artFallback}>{fallbackLetter}</div>
                )}
              </div>
            );

            const info = (
              <div className={styles.info}>
                <h3
                  className={styles.name}
                  style={item.feed ? { viewTransitionName: `feed-title-${item.feed.slug}` } : undefined}
                >
                  {title}
                </h3>
                {author ? <div className={styles.author}>{author}</div> : null}
                <div className={styles.meta}>
                  {item.feed ? (
                    <>
                      <span>
                        {item.feed.episodeCount} ep{item.feed.episodeCount !== 1 ? "s" : ""}
                      </span>
                      {item.feed.latestEpisodePubDate ? (
                        <span>{lastUpdatedLabel(item.feed.latestEpisodePubDate)}</span>
                      ) : null}
                    </>
                  ) : item.itunes?.trackCount ? (
                    <span>
                      {item.itunes.trackCount} ep{item.itunes.trackCount !== 1 ? "s" : ""}
                    </span>
                  ) : null}
                </div>
              </div>
            );

            if (item.feed) {
              return (
                <Link
                  className={styles.card}
                  key={item.key}
                  state={{ title: item.feed.title, imageUrl: item.feed.imageUrl }}
                  to={`/${item.feed.slug}`}
                  viewTransition
                >
                  {art}
                  {info}
                </Link>
              );
            }

            const isImporting = importingKey === item.key;
            return (
              <button
                className={styles.card}
                disabled={isImporting}
                key={item.key}
                onClick={() => void handleImport(item)}
                type="button"
              >
                {art}
                {info}
                <span className={styles.importBadge}>{isImporting ? "Importing…" : "Import"}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
