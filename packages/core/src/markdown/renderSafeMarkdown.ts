// A small, dependency-free markdown-ish renderer for displaying LLM output
// (the final answer, agent messages). Input is HTML-escaped FIRST, and every
// subsequent step only wraps already-escaped text in safe tags - it never
// unescapes anything - so this is safe to use with dangerouslySetInnerHTML
// even though the source text is untrusted (model output).

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderSafeMarkdown(input: string): string {
  const escaped = escapeHtml(input);

  // Extract fenced/inline code into placeholders first, so later markdown
  // transforms (bold, italic, headers) never reach inside code content.
  const codeBlocks: string[] = [];
  const stash = (html: string): string => {
    const i = codeBlocks.length;
    codeBlocks.push(html);
    return ` CODE${i} `;
  };

  let html = escaped;
  html = html.replace(/```([\s\S]*?)```/g, (_m, code: string) => stash(`<pre><code>${code}</code></pre>`));
  html = html.replace(/`([^`\n]+)`/g, (_m, code: string) => stash(`<code>${code}</code>`));

  // Headers
  html = html.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.*)$/gm, '<h1>$1</h1>');
  // Bold / italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  // Unordered list items, then wrap consecutive <li> runs in <ul>
  html = html.replace(/^[-*] (.*)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);

  // Blockquotes
  html = html.replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/(<blockquote>.*<\/blockquote>\n?)+/g, (m) => `<blockquote>${m.replace(/<\/blockquote>\n?<blockquote>/g, '<br/>').replace(/<\/?blockquote>/g, '')}</blockquote>`);

  // Wrap remaining bare lines/blocks into paragraphs, leaving block-level
  // elements we already produced untouched.
  html = html
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (trimmed === '') return '';
      if (/^<(h1|h2|h3|ul|pre|blockquote)/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, '<br/>')}</p>`;
    })
    .filter(Boolean)
    .join('\n');

  html = html.replace(/ ?CODE(\d+) ?/g, (_m, i: string) => codeBlocks[Number(i)]);

  return html;
}
