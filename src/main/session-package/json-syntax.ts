// Syntax only: never build a value tree or retain research strings/numbers. A failed
// recognizer keeps the original text policy; it cannot make an export more permissive.
// Grammar: RFC 8259. Multiple documents must be single-line, newline-separated JSON.
type Expectation = 'value' | 'key' | 'members' | 'elements' | 'object-tail' | 'array-tail' | ':'

export class PackageJsonSyntax {
  private stack: Expectation[] = ['value']
  private token = ''
  private string = false
  private escape = false
  private unicode = 0
  private failed = false
  private started = false
  private multiline = false
  private multiple = false
  private separated = false

  write(text: string): void {
    for (const char of text) {
      if (this.failed) return
      if (this.string) {
        if (this.unicode) {
          if (!/[0-9a-f]/i.test(char)) this.failed = true
          this.unicode--
        } else if (this.escape) {
          if (char === 'u') this.unicode = 4
          else if (!'"\\/bfnrt'.includes(char)) this.failed = true
          this.escape = false
        } else if (char === '\\') this.escape = true
        else if (char === '"') {
          this.string = false
          this.accept('string')
        } else if (char.charCodeAt(0) < 32) this.failed = true
        continue
      }
      if (this.token) {
        if (/[0-9a-z.+-]/i.test(char)) {
          // Compress a number's digit runs without accepting forbidden leading zeroes.
          if (/\d$/.test(this.token) && /\d/.test(char)) {
            if (this.token === '0' || this.token === '-0') this.failed = true
          } else this.token += char
          if (
            this.token !== '-' &&
            !/^-?(?:0|[1-9]\d*)(?:\.\d*)?(?:[eE][+-]?\d*)?$/.test(this.token) &&
            !['true', 'false', 'null'].some((literal) => literal.startsWith(this.token))
          )
            this.failed = true
          continue
        }
        this.finishToken()
      }
      if (/^[ \t\r\n]$/.test(char)) {
        if (char === '\n' && this.started) {
          if (this.stack.length === 0) this.separated = true
          else {
            this.multiline = true
            if (this.multiple) this.failed = true
          }
        }
        continue
      }
      if (this.stack.length === 0) {
        if (!this.separated || this.multiline) {
          this.failed = true
          return
        }
        this.multiple = true
        this.separated = false
        this.stack.push('value')
      }
      this.started = true
      if (char === '"') this.string = true
      else if (/[0-9tfn-]/.test(char)) this.token = char
      else this.accept(char)
    }
  }

  finish(): boolean {
    if (this.token) this.finishToken()
    return !this.failed && !this.string && this.started && this.stack.length === 0
  }

  private finishToken(): void {
    try {
      // Tokens stay tiny even for arbitrarily long numbers. JSON.parse owns the
      // final number/literal validation, including incomplete exponents/fractions.
      JSON.parse(this.token)
      this.accept('scalar')
    } catch {
      this.failed = true
    }
    this.token = ''
  }

  private accept(token: string): void {
    const expected = this.stack.pop()
    if (expected === 'members' && token === '}') return
    if (expected === 'elements' && token === ']') return
    if (expected === 'members' || expected === 'key') {
      if (token === 'string') this.stack.push('object-tail', 'value', ':')
      else this.failed = true
    } else if (expected === 'elements' || expected === 'value') {
      if (expected === 'elements') this.stack.push('array-tail')
      if (token === '{') this.stack.push('members')
      else if (token === '[') this.stack.push('elements')
      else if (token !== 'string' && token !== 'scalar') this.failed = true
    } else if (expected === 'object-tail') {
      if (token === ',') this.stack.push('key')
      else if (token !== '}') this.failed = true
    } else if (expected === 'array-tail') {
      if (token === ',') this.stack.push('array-tail', 'value')
      else if (token !== ']') this.failed = true
    } else if (expected !== ':' || token !== ':') this.failed = true
    // RFC 8259 permits a nesting limit. Over-limit inputs keep the conservative
    // text check; do not retain an unbounded structural stack for the exception.
    if (this.stack.length > 1024) this.failed = true
  }
}
