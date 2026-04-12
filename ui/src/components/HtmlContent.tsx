import styles from "./HtmlContent.module.css";

const ALLOWED_TAGS = new Set([
  "p", "br", "b", "strong", "i", "em", "a", "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "span", "div",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
};

function sanitize(html: string): string {
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, tag: string, attrs: string) => {
    const lower = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(lower)) return "";

    const isClosing = match.startsWith("</");
    if (isClosing) return `</${lower}>`;

    const allowed = ALLOWED_ATTRS[lower];
    if (!allowed) return `<${lower}>`;

    const cleaned = attrs.replace(
      /\s([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
      (_m: string, attr: string, dq: string | undefined, sq: string | undefined) => {
        const name = attr.toLowerCase();
        const value = dq ?? sq ?? "";
        if (!allowed.has(name)) return "";
        if (name === "href" && /^javascript:/i.test(value.trim())) return "";
        return ` ${name}="${value}"`;
      }
    );

    return `<${lower}${cleaned}>`;
  });
}

interface HtmlContentProps {
  html: string;
  className?: string;
}

export function HtmlContent({ html, className }: HtmlContentProps) {
  return (
    <div
      className={`${styles.root} ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: sanitize(html) }}
    />
  );
}
