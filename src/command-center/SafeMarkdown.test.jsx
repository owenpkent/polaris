import { describe, test, expect, afterEach } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import SafeMarkdown, { isSafeHref } from './SafeMarkdown'

afterEach(() => {
  cleanup()
})

describe('SafeMarkdown empty input', () => {
  test('renders nothing for empty string', () => {
    const { container } = render(<SafeMarkdown text="" />)
    expect(container.innerHTML).toBe('')
  })

  test('renders nothing for null', () => {
    const { container } = render(<SafeMarkdown text={null} />)
    expect(container.innerHTML).toBe('')
  })

  test('renders nothing for undefined', () => {
    const { container } = render(<SafeMarkdown text={undefined} />)
    expect(container.innerHTML).toBe('')
  })

  test('does not throw for very long input', () => {
    const long = 'word '.repeat(50000)
    expect(() => render(<SafeMarkdown text={long} />)).not.toThrow()
  })
})

describe('SafeMarkdown headings', () => {
  test('renders h1 through h4 markdown as h2 through h5 tags', () => {
    const text = '# One\n\n## Two\n\n### Three\n\n#### Four'
    const { container } = render(<SafeMarkdown text={text} />)
    const h2 = container.querySelector('h2')
    const h3 = container.querySelector('h3')
    const h4 = container.querySelector('h4')
    const h5 = container.querySelector('h5')
    expect(h2.textContent).toBe('One')
    expect(h3.textContent).toBe('Two')
    expect(h4.textContent).toBe('Three')
    expect(h5.textContent).toBe('Four')
  })

  test('a lone # with no following space is not treated as a heading', () => {
    const { container } = render(<SafeMarkdown text="#nothashheading" />)
    expect(container.querySelector('h2')).toBeNull()
    expect(container.querySelector('p').textContent).toBe('#nothashheading')
  })

  test('five hashes is not a supported heading level and falls into a paragraph', () => {
    const { container } = render(<SafeMarkdown text="##### Five" />)
    // the regex only matches 1-4 hashes anchored at start, "##### Five" has 5 hashes
    // so headingMatch requires (#{1,4}) followed by \s+; "#####" fails since the 5th
    // hash isn't whitespace, so this line is treated as a paragraph
    expect(container.querySelector('h2')).toBeNull()
    expect(container.querySelector('h3')).toBeNull()
    const p = container.querySelector('p')
    expect(p).not.toBeNull()
    expect(p.textContent).toBe('##### Five')
  })

  test('heading supports inline markdown inside it', () => {
    const { container } = render(<SafeMarkdown text="# Hello **world**" />)
    const h2 = container.querySelector('h2')
    expect(h2.querySelector('strong').textContent).toBe('world')
  })
})

describe('SafeMarkdown paragraphs', () => {
  test('renders a single line as a paragraph', () => {
    const { container } = render(<SafeMarkdown text="Just a sentence." />)
    const p = container.querySelector('p')
    expect(p.textContent).toBe('Just a sentence.')
  })

  test('joins consecutive non-blank lines into one paragraph separated by a space', () => {
    const { container } = render(<SafeMarkdown text={'Line one\nLine two'} />)
    const ps = container.querySelectorAll('p')
    expect(ps.length).toBe(1)
    expect(ps[0].textContent).toBe('Line one Line two')
  })

  test('blank lines separate paragraphs', () => {
    const { container } = render(<SafeMarkdown text={'Para one\n\nPara two'} />)
    const ps = container.querySelectorAll('p')
    expect(ps.length).toBe(2)
    expect(ps[0].textContent).toBe('Para one')
    expect(ps[1].textContent).toBe('Para two')
  })

  test('CRLF line endings are normalized like LF', () => {
    const { container } = render(<SafeMarkdown text={'Para one\r\n\r\nPara two'} />)
    const ps = container.querySelectorAll('p')
    expect(ps.length).toBe(2)
    expect(ps[1].textContent).toBe('Para two')
  })
})

describe('SafeMarkdown lists', () => {
  test('renders an unordered list from - items', () => {
    const { container } = render(<SafeMarkdown text={'- one\n- two\n- three'} />)
    const ul = container.querySelector('ul')
    expect(ul).not.toBeNull()
    const items = ul.querySelectorAll('li')
    expect(items.length).toBe(3)
    expect(items[0].textContent).toBe('one')
    expect(items[2].textContent).toBe('three')
  })

  test('renders an unordered list from * items', () => {
    const { container } = render(<SafeMarkdown text={'* alpha\n* beta'} />)
    const ul = container.querySelector('ul')
    expect(ul).not.toBeNull()
    expect(ul.querySelectorAll('li').length).toBe(2)
  })

  test('renders an ordered list from numbered items', () => {
    const { container } = render(<SafeMarkdown text={'1. first\n2. second\n3. third'} />)
    const ol = container.querySelector('ol')
    expect(ol).not.toBeNull()
    const items = ol.querySelectorAll('li')
    expect(items.length).toBe(3)
    expect(items[1].textContent).toBe('second')
  })

  test('list items support inline markdown', () => {
    const { container } = render(<SafeMarkdown text={'- **bold** item\n- normal'} />)
    const li = container.querySelectorAll('li')[0]
    expect(li.querySelector('strong').textContent).toBe('bold')
  })

  test('a list stops at a blank line and a following paragraph is separate', () => {
    const { container } = render(<SafeMarkdown text={'- one\n- two\n\nAfter list'} />)
    const ul = container.querySelector('ul')
    expect(ul.querySelectorAll('li').length).toBe(2)
    const p = container.querySelector('p')
    expect(p.textContent).toBe('After list')
  })

  test('indented list markers are still recognized', () => {
    const { container } = render(<SafeMarkdown text="  - indented item" />)
    const ul = container.querySelector('ul')
    expect(ul).not.toBeNull()
    expect(ul.querySelector('li').textContent).toBe('indented item')
  })
})

describe('SafeMarkdown fenced code blocks', () => {
  test('renders a fenced code block as pre > code', () => {
    const { container } = render(<SafeMarkdown text={'```\nconst x = 1\n```'} />)
    const pre = container.querySelector('pre')
    expect(pre).not.toBeNull()
    const code = pre.querySelector('code')
    expect(code.textContent).toBe('const x = 1')
  })

  test('multi-line fenced code block preserves internal newlines', () => {
    const text = '```\nline1\nline2\nline3\n```'
    const { container } = render(<SafeMarkdown text={text} />)
    const code = container.querySelector('pre code')
    expect(code.textContent).toBe('line1\nline2\nline3')
  })

  test('code inside a fence is not interpreted as inline markdown', () => {
    const text = '```\n**not bold** [not a link](x)\n```'
    const { container } = render(<SafeMarkdown text={text} />)
    const code = container.querySelector('pre code')
    expect(code.textContent).toBe('**not bold** [not a link](x)')
    expect(code.querySelector('strong')).toBeNull()
    expect(code.querySelector('a')).toBeNull()
  })

  test('an unterminated fence consumes the rest of the input without throwing', () => {
    const text = '```\nunterminated code\nmore text'
    expect(() => render(<SafeMarkdown text={text} />)).not.toThrow()
    const { container } = render(<SafeMarkdown text={text} />)
    const code = container.querySelector('pre code')
    expect(code.textContent).toBe('unterminated code\nmore text')
  })
})

describe('SafeMarkdown inline formatting', () => {
  test('renders bold text as strong', () => {
    const { container } = render(<SafeMarkdown text="This is **bold** text" />)
    const strong = container.querySelector('strong')
    expect(strong.textContent).toBe('bold')
    expect(container.querySelector('p').textContent).toBe('This is bold text')
  })

  test('renders inline code as code element', () => {
    const { container } = render(<SafeMarkdown text="Use `npm test` to run" />)
    const code = container.querySelector('code')
    expect(code.textContent).toBe('npm test')
  })

  test('renders multiple inline constructs in one line', () => {
    const { container } = render(<SafeMarkdown text="**bold** and `code` and [link](https://example.com)" />)
    const p = container.querySelector('p')
    expect(p.querySelector('strong').textContent).toBe('bold')
    expect(p.querySelector('code').textContent).toBe('code')
    expect(p.querySelector('a').textContent).toBe('link')
  })

  test('unterminated bold markers are left as literal text', () => {
    const { container } = render(<SafeMarkdown text="**never closed" />)
    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelector('p').textContent).toBe('**never closed')
  })

  test('unterminated inline code backtick is left as literal text', () => {
    const { container } = render(<SafeMarkdown text="`never closed" />)
    expect(container.querySelector('code')).toBeNull()
    expect(container.querySelector('p').textContent).toBe('`never closed')
  })
})

describe('SafeMarkdown links: allowed schemes', () => {
  test('https link is rendered as a clickable anchor', () => {
    const { container } = render(<SafeMarkdown text="[go](https://example.com/path)" />)
    const a = container.querySelector('a')
    expect(a.getAttribute('href')).toBe('https://example.com/path')
    expect(a.textContent).toBe('go')
  })

  test('http link is rendered as a clickable anchor', () => {
    const { container } = render(<SafeMarkdown text="[go](http://example.com)" />)
    const a = container.querySelector('a')
    expect(a.getAttribute('href')).toBe('http://example.com')
  })

  test('uppercase HTTPS scheme is treated as safe', () => {
    const { container } = render(<SafeMarkdown text="[go](HTTPS://example.com)" />)
    const a = container.querySelector('a')
    expect(a.getAttribute('href')).toBe('HTTPS://example.com')
  })

  test('mailto link is rendered as a clickable anchor', () => {
    const { container } = render(<SafeMarkdown text="[email me](mailto:someone@example.com)" />)
    const a = container.querySelector('a')
    expect(a.getAttribute('href')).toBe('mailto:someone@example.com')
  })

  test('links carry target=_blank and rel=noopener noreferrer', () => {
    const { container } = render(<SafeMarkdown text="[go](https://example.com)" />)
    const a = container.querySelector('a')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  })
})

describe('SafeMarkdown links: dangerous schemes are neutralized', () => {
  test('javascript: href produces an anchor with no href attribute', () => {
    const { container } = render(<SafeMarkdown text="[click me](javascript:alert(1))" />)
    const a = container.querySelector('a')
    expect(a).not.toBeNull()
    expect(a.getAttribute('href')).toBeNull()
    expect(a.textContent).toBe('click me')
  })

  test('mixed-case Javascript: scheme is also neutralized', () => {
    const { container } = render(<SafeMarkdown text="[click](JaVaScRiPt:alert(1))" />)
    const a = container.querySelector('a')
    expect(a.getAttribute('href')).toBeNull()
  })

  test('data: href produces an anchor with no href attribute', () => {
    const { container } = render(<SafeMarkdown text="[img](data:text/html,<script>alert(1)</script>)" />)
    const a = container.querySelector('a')
    expect(a.getAttribute('href')).toBeNull()
  })

  test('vbscript: href produces an anchor with no href attribute', () => {
    const { container } = render(<SafeMarkdown text="[click](vbscript:msgbox(1))" />)
    const a = container.querySelector('a')
    expect(a.getAttribute('href')).toBeNull()
  })

  test('leading whitespace before javascript: still yields no clickable href', () => {
    // isSafeHref is an allowlist anchored at the first character, so a leading space already
    // fails it and the href is dropped.
    const { container } = render(<SafeMarkdown text="[click]( javascript:alert(1))" />)
    const a = container.querySelector('a')
    expect(a.getAttribute('href')).toBeNull()
  })

  test('a scheme-relative //evil.com href is not treated as safe', () => {
    const { container } = render(<SafeMarkdown text="[go](//evil.com)" />)
    const a = container.querySelector('a')
    expect(a.getAttribute('href')).toBeNull()
  })

  test('plain relative path href is not treated as safe', () => {
    const { container } = render(<SafeMarkdown text="[go](/some/path)" />)
    const a = container.querySelector('a')
    expect(a.getAttribute('href')).toBeNull()
  })

  test('isSafeHref rejects a control-character-prefixed javascript scheme', () => {
    // Safe because the allowlist is a strict prefix match with no trimming. If a caller ever
    // trims or normalizes an href before calling isSafeHref, re-check these inputs.
    expect(isSafeHref('\u0000javascript:alert(1)')).toBe(false)
    expect(isSafeHref('\tjavascript:alert(1)')).toBe(false)
  })

  test('isSafeHref direct unit checks for allowed and disallowed schemes', () => {
    expect(isSafeHref('https://example.com')).toBe(true)
    expect(isSafeHref('http://example.com')).toBe(true)
    expect(isSafeHref('mailto:a@b.com')).toBe(true)
    expect(isSafeHref('javascript:alert(1)')).toBe(false)
    expect(isSafeHref('JAVASCRIPT:alert(1)')).toBe(false)
    expect(isSafeHref('data:text/html,x')).toBe(false)
    expect(isSafeHref('vbscript:x')).toBe(false)
    expect(isSafeHref('ftp://example.com')).toBe(false)
    expect(isSafeHref('')).toBe(false)
  })
})

describe('SafeMarkdown raw HTML is never parsed as elements', () => {
  test('a script tag in the input renders as inert text, not a script element', () => {
    const { container } = render(<SafeMarkdown text="<script>alert(1)</script>" />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  test('an img with onerror renders as text and no img element is created', () => {
    const { container } = render(<SafeMarkdown text='<img src=x onerror="alert(1)">' />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">')
  })

  test('an iframe tag renders as text and no iframe element is created', () => {
    const { container } = render(<SafeMarkdown text='<iframe src="javascript:alert(1)"></iframe>' />)
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain('<iframe src="javascript:alert(1)"></iframe>')
  })

  test('raw html mixed with markdown does not create real elements outside the markdown constructs', () => {
    const { container } = render(<SafeMarkdown text='**bold** <div onclick="evil()">not a real div</div>' />)
    // SafeMarkdown always wraps its output in one real <div>, so only that wrapper
    // should be present, no additional <div> created from the raw html text
    expect(container.querySelectorAll('div').length).toBe(1)
    expect(container.querySelector('strong').textContent).toBe('bold')
    expect(container.textContent).toContain('<div onclick="evil()">not a real div</div>')
  })

  test('nested and malformed html tags do not throw and do not create elements', () => {
    const text = '<div><span><script>alert(1)</script></span'
    expect(() => render(<SafeMarkdown text={text} />)).not.toThrow()
    const { container } = render(<SafeMarkdown text={text} />)
    // only SafeMarkdown's own outer wrapper <div> should exist, none from the raw html
    expect(container.querySelectorAll('div').length).toBe(1)
    expect(container.querySelector('span')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
  })

  test('an html anchor tag written as raw html does not become a real anchor via markdown link', () => {
    const { container } = render(<SafeMarkdown text='<a href="javascript:alert(1)">click</a>' />)
    // raw html <a> is not the same as markdown [text](href), so no <a> element should be
    // produced at all here, it should remain literal text
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('<a href="javascript:alert(1)">click</a>')
  })
})

describe('SafeMarkdown mixed content and robustness', () => {
  test('a heading, list, code block and paragraph together render as distinct blocks', () => {
    const text = '# Title\n\nSome intro text.\n\n- item one\n- item two\n\n```\ncode here\n```\n\nClosing paragraph.'
    const { container } = render(<SafeMarkdown text={text} />)
    expect(container.querySelector('h2').textContent).toBe('Title')
    expect(container.querySelectorAll('p').length).toBe(2)
    expect(container.querySelector('ul').querySelectorAll('li').length).toBe(2)
    expect(container.querySelector('pre code').textContent).toBe('code here')
  })

  test('does not throw on a string containing only whitespace and newlines', () => {
    expect(() => render(<SafeMarkdown text={'   \n\n   \n'} />)).not.toThrow()
  })

  test('a link with an empty label is not recognized as a link at all', () => {
    // the inline pattern requires at least one character inside the brackets
    // ([^\]]+), so an empty label falls through as literal paragraph text
    const { container } = render(<SafeMarkdown text="[](https://example.com)" />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('p').textContent).toBe('[](https://example.com)')
  })

  test('a link label containing bold markup is inserted as literal text, not further parsed', () => {
    const { container } = render(<SafeMarkdown text="[**bold** label](https://example.com)" />)
    const a = container.querySelector('a')
    expect(a.textContent).toBe('**bold** label')
    expect(a.querySelector('strong')).toBeNull()
  })

  test('does not throw on deeply repeated inline markers', () => {
    const text = '**'.repeat(500) + 'x' + '**'.repeat(500)
    expect(() => render(<SafeMarkdown text={text} />)).not.toThrow()
  })
})

// TaskDetailPanel and InboxTab both gate task.sourceUrl on this before linking it. On a
// third-party task that url is attacker-controlled, and the dashboard origin holds the API token.
describe('isSafeHref as the sourceUrl gate', () => {
  test('passes the schemes a real source url uses', () => {
    expect(isSafeHref('https://github.com/owenpkent/Octavium/issues/7')).toBe(true)
    expect(isSafeHref('http://127.0.0.1:8788/x')).toBe(true)
    expect(isSafeHref('mailto:someone@example.com')).toBe(true)
  })

  test('rejects the schemes that execute or embed', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false)
    expect(isSafeHref('JavaScript:alert(1)')).toBe(false)
    expect(isSafeHref('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false)
    expect(isSafeHref('file:///etc/passwd')).toBe(false)
  })
})
