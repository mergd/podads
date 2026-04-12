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
import { useLocation } from "react-router-dom";

import { fetchFeeds } from "../lib/api";
import type { FeedSummary } from "@podads/shared/api";

type ShowsSearchContextValue = {
  feeds: FeedSummary[];
  total: number;
  isLoading: boolean;
  hasLoaded: boolean;
  query: string;
  setQuery: (value: string) => void;
};

const ShowsSearchContext = createContext<ShowsSearchContextValue | null>(null);

export function ShowsSearchProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [feeds, setFeeds] = useState<FeedSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [query, setQueryState] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const queryRef = useRef(query);
  queryRef.current = query;

  const load = useCallback(async (q: string) => {
    setIsLoading(true);
    try {
      const result = await fetchFeeds(q || undefined);
      setFeeds(result.feeds);
      setTotal(result.total);
    } catch {
      // keep existing state on error
    } finally {
      setIsLoading(false);
      setHasLoaded(true);
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

  useEffect(() => {
    if (location.pathname !== "/shows") return;
    void load(queryRef.current);
  }, [location.pathname, load]);

  const value = useMemo(
    () => ({
      feeds,
      total,
      isLoading,
      hasLoaded,
      query,
      setQuery,
    }),
    [feeds, total, isLoading, hasLoaded, query, setQuery],
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
