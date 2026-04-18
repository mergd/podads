import styles from "./BrandCorner.module.css";
import { useImageCornerTone } from "./useImageCornerTone";

interface BrandCornerProps {
  src?: string | null;
  className?: string;
}

export function BrandCorner({ src, className }: BrandCornerProps) {
  const tone = useImageCornerTone(src);
  const variantClass = tone === "light" ? styles.dark : styles.blue;
  return (
    <span
      aria-hidden
      className={`${styles.badge} ${variantClass} ${className ?? ""}`.trim()}
      title="podads"
    />
  );
}
