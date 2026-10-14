import { PlaylistTest } from './playlistParser';

type TermKind = 'class' | 'project' | 'name';
type MatchOperator = 'contains' | 'exact';

type FilterNode =
  | { type: 'or'; children: FilterNode[] }
  | { type: 'and'; children: FilterNode[] }
  | { type: 'term'; kind: TermKind; op: MatchOperator; value: string };

export interface TestFilter {
  raw: string;
  root: FilterNode;
}

type Token =
  | { type: 'lparen' | 'rparen' | 'or' | 'and' }
  | { type: 'term'; text: string };

interface QualifierContext {
  kind: TermKind;
  op: MatchOperator;
}

const QUALIFIER_RE = /^(class|project)([:=])(.+)$/i;
const BARE_QUALIFIER_RE = /^(class|project)([:=])$/i;
const MAX_GROUP_DEPTH = 64;

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
//   unary := term | [class:|class=|project:|project=] '(' expr ')' | '(' expr ')'
// A class/project qualifier with ':' (contains) or '=' (exact match) on a term or parenthesized group sets the match
// kind and operator; a qualifier inside a group overrides an inherited one. Adjacent terms
// with no operator are implicitly AND-ed (so old space-separated filters still
// work). The parser is tolerant: empty operands and stray parens are dropped.
class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): FilterNode | undefined {
    // A stray ')' ends the inner parse early; drop it and keep going, AND-ing
    // what follows, so trailing terms are never silently discarded.
    const children: FilterNode[] = [];
    while (this.pos < this.tokens.length) {
      const node = this.parseOr(undefined);
      if (node) {
        children.push(node);
      }
      if (this.peek()?.type === 'rparen') {
        this.pos++;
      }
    }
    return combine('and', children);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private parseOr(inherited: QualifierContext | undefined): FilterNode | undefined {
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

  private parseAnd(inherited: QualifierContext | undefined): FilterNode | undefined {
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

  /** Parse the inside of a '(' ... ')' group (the '(' is already consumed). */
  private parseGroup(inherited: QualifierContext | undefined): FilterNode | undefined {
    // Cap nesting so absurd input cannot overflow the stack; a too-deep group
    // is dropped like any other malformed fragment.
    if (this.depth >= MAX_GROUP_DEPTH) {
      return undefined;
    }
    this.depth++;
    try {
      const inner = this.parseOr(inherited);
      if (this.peek()?.type === 'rparen') {
        this.pos++;
      }
      return inner;
    } finally {
      this.depth--;
    }
  }

  private parseUnary(inherited: QualifierContext | undefined): FilterNode | undefined {
    const token = this.peek();
    if (!token) {
      return undefined;
    }
    if (token.type === 'lparen') {
      this.pos++;
      return this.parseGroup(inherited);
    }
    if (token.type === 'term') {
      this.pos++;
      const bare = BARE_QUALIFIER_RE.exec(token.text);
      if (bare && this.peek()?.type === 'lparen') {
        // e.g. class:(a|b) or class=(a|b) — the qualifier distributes over the group.
        this.pos++;
        const context: QualifierContext = {
          kind: bare[1].toLowerCase() as TermKind,
          op: bare[2] === '=' ? 'exact' : 'contains'
        };
        return this.parseGroup(context);
      }
      const qualified = QUALIFIER_RE.exec(token.text);
      const kind = qualified ? (qualified[1].toLowerCase() as TermKind) : inherited?.kind ?? 'name';
      const op = qualified ? (qualified[2] === '=' ? 'exact' : 'contains') : inherited?.op ?? 'contains';
      const value = (qualified ? qualified[3] : token.text).toLowerCase();
      return value.length > 0 ? { type: 'term', kind, op, value } : undefined;
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

/** Lowercased entry fields, computed at most once per entry per evaluation. */
interface LowerFields {
  class?: string;
  project?: string;
  name?: string;
}

function lowerField(entry: PlaylistTest, fields: LowerFields, kind: TermKind): string | undefined {
  if (!(kind in fields)) {
    const source = kind === 'class' ? entry.className : kind === 'project' ? entry.project : entry.testName;
    fields[kind] = source?.toLowerCase();
  }
  return fields[kind];
}

function matchesNode(node: FilterNode, entry: PlaylistTest, fields: LowerFields): boolean {
  if (node.type === 'or') {
    return node.children.some(child => matchesNode(child, entry, fields));
  }
  if (node.type === 'and') {
    return node.children.every(child => matchesNode(child, entry, fields));
  }
  const lowerHaystack = lowerField(entry, fields, node.kind);
  if (lowerHaystack === undefined) {
    return false;
  }
  return node.op === 'exact' ? lowerHaystack === node.value : lowerHaystack.includes(node.value);
}
export function matchesTestFilter(filter: TestFilter, entry: PlaylistTest): boolean {
  return matchesNode(filter.root, entry, {});
}

export function filterEntries(entries: PlaylistTest[], filter: TestFilter | undefined): PlaylistTest[] {
  if (!filter) {
    return entries;
  }
  return entries.filter(entry => matchesTestFilter(filter, entry));
}
