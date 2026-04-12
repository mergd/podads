import { format, formatDistanceToNowStrict, intervalToDuration, isSameDay, isSameYear, isValid, parseISO } from "date-fns";

function parse(value: string): Date | null {
  const date = parseISO(value);
  if (isValid(date)) return date;

  const fallback = new Date(value);
  return isValid(fallback) ? fallback : null;
}

function compactRelativeTime(date: Date): string {
  const relative = formatDistanceToNowStrict(date, { addSuffix: true });

  return relative
    .replace(/^less than a minute ago$/, "just now")
    .replace(/^1 second ago$/, "1 sec ago")
    .replace(/^(\d+) seconds ago$/, "$1 secs ago")
    .replace(/^1 minute ago$/, "1 min ago")
    .replace(/^(\d+) minutes ago$/, "$1 mins ago")
    .replace(/^1 hour ago$/, "1 hr ago")
    .replace(/^(\d+) hours ago$/, "$1 hrs ago")
    .replace(/^1 day ago$/, "1 day ago")
    .replace(/^(\d+) days ago$/, "$1 days ago")
    .replace(/^in 1 second$/, "in 1 sec")
    .replace(/^in (\d+) seconds$/, "in $1 secs")
    .replace(/^in 1 minute$/, "in 1 min")
    .replace(/^in (\d+) minutes$/, "in $1 mins")
    .replace(/^in 1 hour$/, "in 1 hr")
    .replace(/^in (\d+) hours$/, "in $1 hrs")
    .replace(/^in 1 day$/, "in 1 day")
    .replace(/^in (\d+) days$/, "in $1 days");
}

function formatDateLabel(date: Date): string {
  const now = new Date();

  if (isSameYear(date, now)) {
    return format(date, "MMM d");
  }

  return format(date, "MMM d, yyyy");
}

export function isNewContent(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  const date = parse(value);

  if (!date) {
    return false;
  }

  const now = new Date();
  return date.getTime() >= now.getTime() - 2 * 24 * 60 * 60 * 1000;
}

export function shortDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = parse(value);
  if (!date) return value;

  try {
    const now = new Date();

    if (Math.abs(now.getTime() - date.getTime()) < 7 * 24 * 60 * 60 * 1000) {
      return compactRelativeTime(date);
    }

    return formatDateLabel(date);
  } catch {
    return value;
  }
}

export function lastUpdatedLabel(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = parse(value);

  if (!date) {
    return `Last updated ${value}`;
  }

  let formatted: string;

  try {
    const now = new Date();

    if (isSameDay(date, now)) {
      formatted = "today";
    } else if (Math.abs(now.getTime() - date.getTime()) < 7 * 24 * 60 * 60 * 1000) {
      formatted = compactRelativeTime(date);
    } else {
      formatted = formatDateLabel(date);
    }
  } catch {
    formatted = value;
  }

  if (!formatted) {
    return null;
  }

  return `Last updated ${formatted}`;
}

export function formatEpisodeDuration(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const totalSeconds = Number.parseInt(trimmed, 10);

    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
      return trimmed;
    }

    const duration = intervalToDuration({ start: 0, end: totalSeconds * 1000 });
    const parts = [
      duration.hours ? `${duration.hours}h` : null,
      duration.minutes ? `${duration.minutes}m` : null,
      duration.seconds ? `${duration.seconds}s` : null
    ].filter((part): part is string => Boolean(part));

    return parts.length > 0 ? parts.join(" ") : "0s";
  }

  if (/^\d+:\d{2}(:\d{2})?$/.test(trimmed)) {
    const segments = trimmed.split(":").map((segment) => Number.parseInt(segment, 10));

    if (segments.some((segment) => !Number.isFinite(segment))) {
      return trimmed;
    }

    if (segments.length === 2) {
      const [minutes, seconds] = segments;
      return `${minutes}m ${seconds}s`;
    }

    const [hours, minutes, seconds] = segments;
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return trimmed;
}
