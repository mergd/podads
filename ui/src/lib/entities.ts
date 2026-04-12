let textarea: HTMLTextAreaElement | null = null;

export function decodeEntities(text: string): string {
  if (!textarea) {
    textarea = document.createElement("textarea");
  }
  textarea.innerHTML = text;
  return textarea.value;
}
