import type { CSSProperties } from "react";
import styles from "./Skeleton.module.css";

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  variant?: "rectangular" | "circular" | "rounded";
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({
  width,
  height,
  variant = "rectangular",
  className,
  style,
}: SkeletonProps) {
  const classes = [
    styles.bone,
    variant === "circular" && styles.circular,
    variant === "rounded" && styles.rounded,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <div className={classes} style={{ width, height, ...style }} />;
}
