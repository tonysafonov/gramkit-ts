/** The verification email's HTML. */
import { describe, expect, it } from 'vitest';
import { buildEmailHtml } from './email';

describe('buildEmailHtml', () => {
  it('greets by name, and the code is in it', () => {
    const html = buildEmailHtml('123456', 'Ann');

    expect(html).toContain('Hi Ann,');
    expect(html).toContain('123456');
  });

  it('escapes the name: a display name is whatever the user typed', () => {
    const html = buildEmailHtml('123456', `<a href="https://evil.example">Reset</a> & 'x'`);

    expect(html).not.toContain('<a href');
    expect(html).toContain('Hi &lt;a href=&quot;https://evil.example&quot;&gt;Reset&lt;/a&gt; &amp; &#x27;x&#x27;,');
  });

  it('no name, no name', () => {
    expect(buildEmailHtml('123456', null)).toContain('<p style="color: #666; font-size: 16px;">Hi,</p>');
  });
});
