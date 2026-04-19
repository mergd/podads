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
      if (q.trim().length === 0) {
        const result = await fetchFeeds();
        if (requestId !== requestIdRef.current) return;
        setItems(result.feeds.map(itemFromFeed));
        setTotal(result.total);
      } else {
        const result = await searchPodcasts(q);
        if (requestId !== requestIdRef.current) return;
        setItems(
          result.results.map((entry) => ({
            key: `itunes:${entry.itunes.collectionId}`,
            feed: entry.feed,
            itunes: entry.itunes,
          })),
        );
        setTotal(result.results.length);
      }
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
      debounceRef.current = setTimeout(() => void load(value), 250);
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
