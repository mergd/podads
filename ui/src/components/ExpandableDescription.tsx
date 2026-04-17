import { useEffect, useRef, useState } from "react";

import { HtmlContent } from "./HtmlContent";
import styles from "./ExpandableDescription.module.css";

interface ExpandableDescriptionProps {
  html: string;
  className?: string;
  clampLines?: number;
}

export function ExpandableDescription({ html, className, clampLines = 3 }: ExpandableDescriptionProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const check = () => {
      setOverflowing(el.scrollHeight - el.clientHeight > 1);
    };

    check();

    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [html, clampLines]);

  return (
    <div className={`${styles.wrap} ${className ?? ""}`}>
      <div
        ref={contentRef}
        className={styles.content}
        data-expanded={expanded}
        style={{ ["--clamp-lines" as string]: clampLines }}
      >
        <HtmlContent html={html} />
      </div>
      {(overflowing || expanded) && (
        <button
          className={styles.toggle}
          onClick={() => setExpanded((v) => !v)}
          type="button"
        >
          {expanded ? "Read less" : "Read more"}
        </button>
      )}
    </div>
  );
}
