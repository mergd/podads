import styles from "./BrandCorner.module.css";

interface BrandCornerProps {
  className?: string;
}

export function BrandCorner({ className }: BrandCornerProps) {
  return <span aria-hidden className={`${styles.badge} ${className ?? ""}`.trim()} title="podads" />;
}
