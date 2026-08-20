import { PlaylistTest } from './playlistParser';

type TermKind = 'class' | 'project' | 'name';

type FilterNode =
  | { type: 'or'; children: FilterNode[] }
  | { type: 'and'; children: FilterNode[] }
  | { type: 'term'; kind: TermKind; value: string };

export interface TestFilter {
  raw: string;
  root: FilterNode;
}

type Token =
  | { type: 'lparen' | 'rparen' | 'or' | 'and' }
  | { type: 'term'; text: string };

const QUALIFIER_RE = /^(class|project):(.+)$/i;
const BARE_QUALIFIER_RE = /^(class|project):$/i;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i++;
    } else if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i++;
    } else if (ch === '|') {
      tokens.push({ type: 'or' });
      i++;
    } else if (ch === '&') {
      tokens.push({ type: 'and' });
      i++;
    } else {
      let j = i;
      while (j < input.length && !/[\s()|&]/.test(input[j])) {
        j++;
      }
      tokens.push({ type: 'term', text: input.slice(i, j) });
      i = j;
    }
  }
  return tokens;
}

// Grammar (spaces are insignificant):
//   expr  := and ('|' and)*
//   and   := unary (('&' | juxtaposition) unary)*
//   unary := term | [class:|project:] '(' expr ')' | '(' expr ')'
// A class:/project: qualifier on a term or parenthesized group sets the match
// kind; a qualifier inside a group overrides an inherited one. Adjacent terms
// with no operator are implicitly AND-ed (so old space-separated filters still
// work). The parser is tolerant: empty operands and stray parens are dropped.
class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): FilterNode | undefined {
    return this.parseOr(undefined);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private parseOr(inherited: TermKind | undefined): FilterNode | undefined {
    const children: FilterNode[] = [];
    const first = this.parseAnd(inherited);
    if (first) {
      children.push(first);
    }
    while (this.peek()?.type === 'or') {
      this.pos++;
      const next = this.parseAnd(inherited);
      if (next) {
        children.push(next);
      }
    }
    return combine('or', children);
  }

  private parseAnd(inherited: TermKind | undefined): FilterNode | undefined {
    const children: FilterNode[] = [];
    const first = this.parseUnary(inherited);
    if (first) {
      children.push(first);
    }
    for (;;) {
      const token = this.peek();
      if (token?.type === 'and') {
        this.pos++;
      } else if (token?.type !== 'term' && token?.type !== 'lparen') {
        break;
      }
      // A term or '(' directly after another operand is an implicit AND.
      const next = this.parseUnary(inherited);
      if (next) {
        children.push(next);
      }
    }
    return combine('and', children);
  }

  private parseUnary(inherited: TermKind | undefined): FilterNode | undefined {
    const token = this.peek();
    if (!token) {
      return undefined;
    }
    if (token.type === 'lparen') {
      this.pos++;
      const inner = this.parseOr(inherited);
      if (this.peek()?.type === 'rparen') {
        this.pos++;
      }
      return inner;
    }
    if (token.type === 'term') {
      this.pos++;
      const bare = BARE_QUALIFIER_RE.exec(token.text);
      if (bare && this.peek()?.type === 'lparen') {
        // e.g. class:(a|b) — the qualifier distributes over the group.
        this.pos++;
        const inner = this.parseOr(bare[1].toLowerCase() as TermKind);
        if (this.peek()?.type === 'rparen') {
          this.pos++;
        }
        return inner;
      }
      const qualified = QUALIFIER_RE.exec(token.text);
      const kind = qualified ? (qualified[1].toLowerCase() as TermKind) : inherited ?? 'name';
      const value = (qualified ? qualified[2] : token.text).toLowerCase();
      return value.length > 0 ? { type: 'term', kind, value } : undefined;
    }
    return undefined;
  }
}

function combine(type: 'or' | 'and', children: FilterNode[]): FilterNode | undefined {
  if (children.length === 0) {
    return undefined;
  }
  if (children.length === 1) {
    return children[0];
  }
  return { type, children };
}

export function parseTestFilter(input: string): TestFilter | undefined {
  const raw = input.trim();
  if (!raw) {
    return undefined;
  }
  const root = new Parser(tokenize(raw)).parse();
  if (!root) {
    return undefined;
  }
  return { raw, root };
}

function matchesNode(node: FilterNode, entry: PlaylistTest): boolean {
  if (node.type === 'or') {
    return node.children.some(child => matchesNode(child, entry));
  }
  if (node.type === 'and') {
    return node.children.every(child => matchesNode(child, entry));
  }
  const haystack =
    node.kind === 'class' ? entry.className :
    node.kind === 'project' ? entry.project :
    entry.testName;
  return haystack !== undefined && haystack.toLowerCase().includes(node.value);
}

export function matchesTestFilter(filter: TestFilter, entry: PlaylistTest): boolean {
  return matchesNode(filter.root, entry);
}

export function filterEntries(entries: PlaylistTest[], filter: TestFilter | undefined): PlaylistTest[] {
  if (!filter) {
    return entries;
  }
  return entries.filter(entry => matchesTestFilter(filter, entry));
}
