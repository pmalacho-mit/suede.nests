import type {
  Expect,
  Invoke,
  Construct,
  Call,
  Given,
  Fixture,
  Env,
  FromFile,
  Snapshot,
} from "../release/dsl.import.meta.vitest.ts";

export interface User {
  id: number;
  name: string;
  email: string;
  roles: string[];
  createdAt: string;
}

export interface Clock {
  now(): string;
}

export class UserRepository {
  private users = new Map<number, User>();
  private nextId = 1;
  private readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  async create(
    input: Pick<User, "name" | "email"> & Partial<Pick<User, "roles">>,
  ): Promise<User> {
    if (!input.email.includes("@"))
      throw new TypeError(`invalid email: ${input.email}`);
    const user: User = {
      id: this.nextId++,
      roles: [],
      ...input,
      createdAt: this.clock.now(),
    };
    this.users.set(user.id, user);
    return user;
  }

  async find(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async list(): Promise<User[]> {
    return [...this.users.values()];
  }

  async grant(id: number, role: string): Promise<void> {
    const user = this.users.get(id);
    if (!user) throw new Error(`no user ${id}`);
    if (!user.roles.includes(role)) user.roles.push(role);
  }
}

declare namespace UserRepository {
  // A frozen clock so `createdAt` is deterministic.
  type FixedClock = Fixture<Clock, { now: typeof fixedNow }>;
  type Repo = Construct<typeof UserRepository, [FixedClock]>;

  type Ada = Call<Repo, "create", [{ name: "Ada"; email: "ada@example.com" }]>;

  /** create() assigns an id, defaults roles, and stamps the clock. */
  export type Create = Expect<
    Ada,
    "matches",
    { id: 1; roles: []; createdAt: "2026-01-01T00:00:00.000Z" }
  >;

  export type CreateSnapshot = Expect<Ada, "=", Snapshot>;

  export type CreateHasEmail = [
    Expect<Ada, "hasKey", "email">,
    Expect<Ada["email"], "includes", "@">,
  ];

  export type RejectsBadEmail = Expect<
    Call<Repo, "create", [{ name: "x"; email: "nope" }]>,
    "throws",
    TypeError
  >;

  /** find() returns the same object create() returned. */
  export type FindReturnsSameObject = Expect<
    Call<Repo, "find", [Ada["id"]]>,
    "is",
    Ada
  >;

  export type FindMissing = Expect<Call<Repo, "find", [999]>, "undefined">;

  /** grant() is idempotent and visible through every handle to the user. */
  export type Grant = Given<
    [
      Call<Repo, "grant", [Ada["id"], "admin"]>,
      Call<Repo, "grant", [Ada["id"], "admin"]>,
    ],
    [
      Expect<Ada["roles"], "=", ["admin"]>,
      Expect<Ada, "satisfies", typeof isAdmin>,
      Expect<Call<Repo, "list", []>, "some", typeof isAdmin>,
      Expect<
        Call<Repo, "list", []>,
        "every",
        Invoke<typeof hasEmailDomain, ["example.com"]>
      >,
    ]
  >;

  export type GrantUnknownUser = Expect<
    Call<Repo, "grant", [42, "admin"]>,
    "throws",
    "no user 42"
  >;

  /** Seed data can come from disk. */
  type Seed = FromFile<
    "./fixtures/users.json",
    "json",
    Array<Pick<User, "name" | "email">>
  >;
  export type SeedShape = [
    Expect<Seed["length"], ">", 0>,
    Expect<Seed[0]["email"], "includes", "@">,
  ];

  /** And from the environment (the runner reads `.env` next to the test file if present). */
  export type Domain = Expect<
    Env<"TEST_EMAIL_DOMAIN", "example.com">,
    "=",
    "example.com"
  >;
}

export const isAdmin = (u: User) => u.roles.includes("admin");
export const hasEmailDomain = (domain: string) => (u: User) =>
  u.email.endsWith(`@${domain}`);



// Test-only helper. Being in the module is fine: it is tiny and tree-shakes away when unused.
export const fixedNow = () => "2026-01-01T00:00:00.000Z";
