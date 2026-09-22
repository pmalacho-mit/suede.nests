import type { Expect, Invoke, Throws, Table, Given, Fixture } from "../release/dsl.import.meta.vitest.ts";

// ─── A tiny arithmetic parser ──────────────────────────────────────────────

export type Expr =
  | { kind: "num"; value: number }
  | { kind: "neg"; expr: Expr }
  | { kind: "bin"; op: "+" | "-" | "*" | "/"; left: Expr; right: Expr };

export class ParseError extends SyntaxError {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.name = "ParseError";
    this.position = position;
  }
}

export function parse(src: string): Expr {
  let i = 0;
  const peek = () => src[i] ?? "";
  const skip = () => {
    while (/\s/.test(peek())) i++;
  };
  const expr = (): Expr => {
    let left = term();
    skip();
    while (peek() === "+" || peek() === "-") {
      const op = src[i++] as "+" | "-";
      left = { kind: "bin", op, left, right: term() };
      skip();
    }
    return left;
  };
  const term = (): Expr => {
    let left = factor();
    skip();
    while (peek() === "*" || peek() === "/") {
      const op = src[i++] as "*" | "/";
      left = { kind: "bin", op, left, right: factor() };
      skip();
    }
    return left;
  };
  const factor = (): Expr => {
    skip();
    if (peek() === "-") {
      i++;
      return { kind: "neg", expr: factor() };
    }
    if (peek() === "(") {
      i++;
      const e = expr();
      skip();
      if (peek() !== ")") throw new ParseError("expected )", i);
      i++;
      return e;
    }
    const m = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (!m)
      throw new ParseError(
        `unexpected ${JSON.stringify(peek() || "end of input")}`,
        i,
      );
    i += m[0].length;
    return { kind: "num", value: Number(m[0]) };
  };
  const result = expr();
  skip();
  if (i < src.length) throw new ParseError(`trailing input`, i);
  return result;
}

export function evaluate(e: Expr): number {
  switch (e.kind) {
    case "num":
      return e.value;
    case "neg":
      return -evaluate(e.expr);
    case "bin": {
      const l = evaluate(e.left);
      const r = evaluate(e.right);
      if (e.op === "/" && r === 0) throw new RangeError("division by zero");
      return e.op === "+"
        ? l + r
        : e.op === "-"
          ? l - r
          : e.op === "*"
            ? l * r
            : l / r;
    }
  }
}

declare namespace Tests.parse {
  export type Number = Expect<
    Invoke<typeof parse, ["42"]>,
    "=",
    { kind: "num"; value: 42 }
  >;

  /** Precedence: `*` binds tighter than `+`. Nested literal objects materialize as plain objects. */
  export type Precedence = Expect<
    Invoke<typeof parse, ["1 + 2 * 3"]>,
    "=",
    {
      kind: "bin";
      op: "+";
      left: { kind: "num"; value: 1 };
      right: {
        kind: "bin";
        op: "*";
        left: { kind: "num"; value: 2 };
        right: { kind: "num"; value: 3 };
      };
    }
  >;

  /** `matches` lets you check just the shape you care about. */
  export type Parens = Expect<
    Invoke<typeof parse, ["(1 + 2) * 3"]>,
    "matches",
    { kind: "bin"; op: "*" }
  >;

  export type Negation = Expect<
    Invoke<typeof parse, ["-5"]>,
    "matches",
    { kind: "neg"; expr: { value: 5 } }
  >;

  export type Errors = [
    Throws<Invoke<typeof parse, ["(1 + 2"]>, ParseError>,
    Throws<
      Invoke<typeof parse, ["1 +"]>,
      { instanceOf: ParseError; matches: "unexpected .*end of input" }
    >,
    Throws<Invoke<typeof parse, ["1 2"]>, "trailing">,
    Throws<Invoke<typeof parse, [""]>>, // any throw at all
  ];
}

declare namespace Tests.evaluate {
  type Parsed<S extends string> = Invoke<typeof parse, [S]>;

  export type Cases = Table<
    typeof evaluate,
    [
      [args: [expr: { kind: "num"; value: -1 }], expected: -1],
      [
        args: [expr: { kind: "neg"; expr: { kind: "num"; value: 2 } }],
        expected: -2,
      ],
      [
        args: [
          expr: {
            kind: "bin";
            op: "/";
            left: { kind: "num"; value: 1 };
            right: { kind: "num"; value: 3 };
          },
        ],
        condition: ["~=", 1e-12],
        expected: 0.3333333333333333,
      ],
      [
        args: [
          expr: {
            kind: "bin";
            op: "/";
            left: { kind: "num"; value: 1 };
            right: { kind: "num"; value: 0 };
          },
        ],
        condition: "throws",
        expected: RangeError,
      ],
    ]
  >;

  /** End-to-end: generic aliases are just macros — `Parsed<"...">` expands at each use. */
  export type EndToEnd = [
    Expect<Invoke<typeof evaluate, [Parsed<"2 * (3 + 4)">]>, "=", 14>,
    Expect<Invoke<typeof evaluate, [Parsed<"-(1 - 3)">]>, "=", 2>,
    Expect<Invoke<typeof evaluate, [Parsed<"10 / 4">]>, "=", 2.5>,
  ];
}

// ─── A reducer ─────────────────────────────────────────────────────────────

export interface Todo {
  id: bigint;
  text: string;
  done: boolean;
  due: string | null;
}
export interface State {
  todos: Todo[];
  filter: "all" | "open" | "done";
}
export type Action =
  | { type: "add"; id: bigint; text: string }
  | { type: "toggle"; id: bigint }
  | { type: "filter"; filter: State["filter"] };

export const initialState: State = { todos: [], filter: "all" };

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "add":
      return {
        ...state,
        todos: [
          ...state.todos,
          { id: action.id, text: action.text, done: false, due: null },
        ],
      };
    case "toggle":
      return {
        ...state,
        todos: state.todos.map((t) =>
          t.id === action.id ? { ...t, done: !t.done } : t,
        ),
      };
    case "filter":
      return { ...state, filter: action.filter };
  }
}

declare namespace Tests.reduce {
  type Empty = Fixture<State, { todos: []; filter: "all" }>;
  type One = Invoke<
    typeof reduce,
    [Empty, { type: "add"; id: 1n; text: "buy milk" }]
  >;

  export type Add = [
    Expect<
      One["todos"],
      "=",
      [{ id: 1n; text: "buy milk"; done: false; due: null }]
    >,
    Expect<One["todos"][0]["due"], "=", null>,
    Expect<One["todos"][0]["id"], "=", 1n>,
  ];

  /** Reducers are pure: the input state is untouched and the output is a new object. */
  export type Pure = Given<
    One,
    [Expect<Empty["todos"], "isEmpty">, Expect<One, "isNot", Empty>]
  >;

  export type Toggle = Expect<
    Invoke<
      typeof reduce,
      [One, { type: "toggle"; id: 1n }]
    >["todos"][0]["done"],
    "=",
    true
  >;

  export type ToggleUnknownIsNoop = Expect<
    Invoke<typeof reduce, [One, { type: "toggle"; id: 2n }]>["todos"],
    "=",
    One["todos"]
  >;

  export type Filter = Expect<
    Invoke<
      typeof reduce,
      [Empty, { type: "filter"; filter: "done" }]
    >["filter"],
    "=",
    "done"
  >;

  /** The exported `initialState` singleton is usable directly via `typeof`. */
  export type InitialIsEmpty = Expect<
    (typeof initialState)["todos"],
    "isEmpty"
  >;
}
