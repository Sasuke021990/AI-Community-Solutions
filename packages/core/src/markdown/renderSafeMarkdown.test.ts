import { describe, it, expect } from 'vitest';
import { renderSafeMarkdown } from './renderSafeMarkdown.js';

describe('renderSafeMarkdown', () => {
  it('escapes raw HTML/script tags in the input rather than passing them through', () => {
    const out = renderSafeMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('escapes HTML that ends up inside generated tags too (bold/code do not unescape)', () => {
    const out = renderSafeMarkdown('**<img src=x onerror=alert(1)>**');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('renders basic markdown constructs', () => {
    const out = renderSafeMarkdown('# Title\n\nSome **bold** and *italic* text.\n\n- one\n- two');
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toContain('<li>one</li>');
    expect(out).toContain('<ul>');
  });

  it('renders fenced code blocks without interpreting markdown inside them', () => {
    const out = renderSafeMarkdown('```\nconst x = "*not bold*";\n```');
    expect(out).toContain('<pre><code>');
    expect(out).toContain('*not bold*');
  });
});
