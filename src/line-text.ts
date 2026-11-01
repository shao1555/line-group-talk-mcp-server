function paragraph(line: string): string {
  if (line.length < 140) return line;
  let start = 0, length = 0, result = '';
  for (const match of line.matchAll(/[。！？][」』）】]*/g)) {
    const end = match.index! + match[0].length;
    result += line.slice(start, end); length += end - start; start = end;
    if (length >= 90 && end < line.length) { result += '\n\n'; length = 0; }
  }
  return result + line.slice(start);
}
/** Preserve model formatting; add paragraph breaks to long Japanese prose as a fallback. */
export function formatLineText(text: string): string {
  return text.replace(/\r\n?/g, '\n').split(/(```[\s\S]*?(?:```|$))/g).map((part, index) => {
    if (index % 2) return part;
    return part.split('\n').map((line) => {
      if (line.includes('`') || /^https?:\/\/\S+$/.test(line.trim())) return line;
      const labels = [...line.matchAll(/・[^・。\n：:]{1,24}[：:]/g)];
      if (labels.length >= 2) {
        const start = labels[0].index!;
        const intro = line.slice(0, start).trimEnd();
        const items = line.slice(start).replace(/(?!^)・(?=[^・。\n：:]{1,24}[：:])/g, '\n・');
        return (intro ? paragraph(intro) + '\n\n' : '') + items.split('\n').map(paragraph).join('\n');
      }
      return line.replace(/([。！？：:])(?=・)/g, '$1\n\n').split('\n').map((item) => paragraph(item.startsWith('・') ? item.replace(/(?!^)・(?=[^・。\n：:]{1,24}[：:])/g, '\n・') : item)).join('\n');
    }).join('\n');
  }).join('');
}
