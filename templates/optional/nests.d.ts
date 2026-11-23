// Lets code that carries nest tests type-check where suede.nests is NOT
// installed. Copy it into your library's source, anywhere your tsconfig
// includes (next to the code is fine), and ship it with that code.
//
// It is a pattern ambient module: TypeScript consults it only when an import
// does not resolve to a real file. Wherever suede.nests is installed at the path
// the tests import from, the real types win and this file is inert, so there is
// nothing to delete to opt in.
declare module "*/dsl.import.meta.vitest" {
  // Deliberately loose: enough for `import type { ... }` and every test written
  // with the DSL to type-check; nothing is evaluated, since nothing runs the tests.
  export namespace Internal {
    type Test = any;
    type Config = any;
    type DisplayPage = any;
    type AnyFn = (...args: any) => any;
    type Literal = any;
    type Node<K extends string = string> = { readonly kind: K };
  }
  export type Invoke<F = any, Args = any, Extra = any> = any;
  export type Construct<C = any, Args = any> = any;
  export type Call<Target = any, Method = any, Args = any> = any;
  export type Fixture<T = any, Initial = any> = any;
  export type FromFile<
    Path extends string = string,
    Kind = any,
    As = any,
  > = any;
  export type Env<Name extends string = string, Value = any, Rest = any> = any;
  export type Snapshot<Name extends string = ""> = any;
  export type Nothing = any;
  export type Expect<
    A = any,
    Condition = any,
    Expected = any,
    Display = any,
  > = any;
  export type Throws<A = any, B = any, C = any> = any;
  export type Given<Effects = any, Then = any> = any;
  export type ExpectGiven<A = any, B = any, C = any, D = any> = any;
  export type Mock<Path extends string = string, With = any> = any;
  export type Mocked<F = any> = any;
  export type Table<F = any, Rows = any> = any;
  export type Skip<T = any, Reason extends string = ""> = any;
  export type SkipIfNotFound<Path extends string = string, T = any> = any;
  export type Only<T = any> = any;
  export type Todo<Reason extends string = ""> = any;
  export type Configure<C = any, T = any> = any;
  export type Caught<Expr = any, E = any> = any;
  export type Spy<F = any, Impl = any> = any;
  export type Calls<S = any> = any;
  export type FakeTimers<Now = any> = any;
  export type AdvanceTimers<Ms = any> = any;
  export type StubEnv<Name extends string = string, Value = any> = any;
  export type TempDir<Files = any> = any;
  export type WriteFile<Path extends string = string, Text = any> = any;
  export type Exists<Path extends string = string> = any;
  export type ListDir<Path extends string = string> = any;
  export type Repeat<Text = any, Count = any> = any;
  // Copied from the real DSL.
  export type Widen<T> = T extends string
    ? string
    : T extends number
      ? number
      : T extends boolean
        ? boolean
        : T extends bigint
          ? bigint
          : T extends symbol
            ? symbol
            : T extends readonly (infer U)[]
              ? Widen<U>[]
              : T extends object
                ? { -readonly [K in keyof T]: Widen<T[K]> }
                : T;
}

// The same module for an import that spells the extension out.
declare module "*/dsl.import.meta.vitest.ts" {
  // Deliberately loose: enough for `import type { ... }` and every test written
  // with the DSL to type-check; nothing is evaluated, since nothing runs the tests.
  export namespace Internal {
    type Test = any;
    type Config = any;
    type DisplayPage = any;
    type AnyFn = (...args: any) => any;
    type Literal = any;
    type Node<K extends string = string> = { readonly kind: K };
  }
  export type Invoke<F = any, Args = any, Extra = any> = any;
  export type Construct<C = any, Args = any> = any;
  export type Call<Target = any, Method = any, Args = any> = any;
  export type Fixture<T = any, Initial = any> = any;
  export type FromFile<
    Path extends string = string,
    Kind = any,
    As = any,
  > = any;
  export type Env<Name extends string = string, Value = any, Rest = any> = any;
  export type Snapshot<Name extends string = ""> = any;
  export type Nothing = any;
  export type Expect<
    A = any,
    Condition = any,
    Expected = any,
    Display = any,
  > = any;
  export type Throws<A = any, B = any, C = any> = any;
  export type Given<Effects = any, Then = any> = any;
  export type ExpectGiven<A = any, B = any, C = any, D = any> = any;
  export type Mock<Path extends string = string, With = any> = any;
  export type Mocked<F = any> = any;
  export type Table<F = any, Rows = any> = any;
  export type Skip<T = any, Reason extends string = ""> = any;
  export type SkipIfNotFound<Path extends string = string, T = any> = any;
  export type Only<T = any> = any;
  export type Todo<Reason extends string = ""> = any;
  export type Configure<C = any, T = any> = any;
  export type Caught<Expr = any, E = any> = any;
  export type Spy<F = any, Impl = any> = any;
  export type Calls<S = any> = any;
  export type FakeTimers<Now = any> = any;
  export type AdvanceTimers<Ms = any> = any;
  export type StubEnv<Name extends string = string, Value = any> = any;
  export type TempDir<Files = any> = any;
  export type WriteFile<Path extends string = string, Text = any> = any;
  export type Exists<Path extends string = string> = any;
  export type ListDir<Path extends string = string> = any;
  export type Repeat<Text = any, Count = any> = any;
  // Copied from the real DSL.
  export type Widen<T> = T extends string
    ? string
    : T extends number
      ? number
      : T extends boolean
        ? boolean
        : T extends bigint
          ? bigint
          : T extends symbol
            ? symbol
            : T extends readonly (infer U)[]
              ? Widen<U>[]
              : T extends object
                ? { -readonly [K in keyof T]: Widen<T[K]> }
                : T;
}
