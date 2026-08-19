import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { fetchFeeds, registerFeed, searchPodcasts } from "../lib/api";
import type { FeedSummary, ItunesPodcastResult } from "@podads/shared/api";

export interface ShowSearchItem {
  key: string;
  feed: FeedSummary | null;
  itunes: ItunesPodcastResult | null;
}

type ShowsSearchContextValue = {
  items: ShowSearchItem[];
  total: number;
  isLoading: boolean;
  hasLoaded: boolean;
  query: string;
  setQuery: (value: string) => void;
  importItem: (item: ShowSearchItem) => Promise<FeedSummary>;
  importingKey: string | null;
};

const ShowsSearchContext = createContext<ShowsSearchContextValue | null>(null);
const SEARCH_DEBOUNCE_MS = 800;

function itemFromFeed(feed: FeedSummary): ShowSearchItem {
  return { key: `feed:${feed.slug}`, feed, itunes: null };
}

export function ShowsSearchProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ShowSearchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [query, setQueryState] = useState("");
  const [importingKey, setImportingKey] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async (q: string) => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    try {
      const trimmedQuery = q.trim();

      if (!trimmedQuery) {
        const catalogResult = await fetchFeeds();
        if (requestId !== requestIdRef.current) return;
        setItems(catalogResult.feeds.map(itemFromFeed));
        setTotal(catalogResult.total);
        return;
      }

      const [catalogResult, directoryResult] = await Promise.all([
        fetchFeeds(trimmedQuery),
        trimmedQuery.length >= 2
          ? searchPodcasts(trimmedQuery)
          : Promise.resolve({ query: trimmedQuery, results: [] }),
      ]);
      if (requestId !== requestIdRef.current) return;

      const catalogSlugs = new Set(catalogResult.feeds.map((feed) => feed.slug));
      const catalogSourceUrls = new Set(catalogResult.feeds.map((feed) => feed.sourceUrl));
      const directoryItems = directoryResult.results
        .filter(
          (entry) =>
            (!entry.feed || !catalogSlugs.has(entry.feed.slug)) && !catalogSourceUrls.has(entry.itunes.feedUrl),
        )
        .map((entry) => ({
          key: `itunes:${entry.itunes.collectionId}`,
          feed: entry.feed,
          itunes: entry.itunes,
        }));

      setItems([...catalogResult.feeds.map(itemFromFeed), ...directoryItems]);
      setTotal(catalogResult.total + directoryItems.length);
    } catch {
      // keep existing state on error
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
        setHasLoaded(true);
      }
    }
  }, []);

  const setQuery = useCallback(
    (value: string) => {
      setQueryState(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => void load(value), SEARCH_DEBOUNCE_MS);
    },
    [load],
  );

  const importItem = useCallback(async (item: ShowSearchItem): Promise<FeedSummary> => {
    if (item.feed) return item.feed;
    if (!item.itunes) throw new Error("Nothing to import.");
    setImportingKey(item.key);
    try {
      const registered = await registerFeed(item.itunes.feedUrl);
      setItems((prev) =>
        prev.map((existing) => (existing.key === item.key ? { ...existing, feed: registered.feed } : existing)),
      );
      return registered.feed;
    } finally {
      setImportingKey((current) => (current === item.key ? null : current));
    }
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  const value = useMemo(
    () => ({
      items,
      total,
      isLoading,
      hasLoaded,
      query,
      setQuery,
      importItem,
      importingKey,
    }),
    [items, total, isLoading, hasLoaded, query, setQuery, importItem, importingKey],
  );

  return <ShowsSearchContext.Provider value={value}>{children}</ShowsSearchContext.Provider>;
}

export function useShowsSearch() {
  const ctx = useContext(ShowsSearchContext);
  if (!ctx) {
    throw new Error("useShowsSearch must be used within ShowsSearchProvider");
  }
  return ctx;
}
