import { useShowsSearch } from "../contexts/showsSearch";
import styles from "./ShowsTopBarSearch.module.css";

export function ShowsTopBarSearch() {
  const { query, setQuery, isLoading, hasLoaded } = useShowsSearch();

  return (
    <div className={styles.wrap}>
      <input
        aria-label="Search shows"
        className={styles.search}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search shows…"
        type="search"
        value={query}
      />
      {isLoading && hasLoaded ? <div className={styles.spinner} aria-hidden /> : null}
    </div>
  );
}
