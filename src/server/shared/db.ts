/**
 * The database handle type, named once.
 *
 * The routers previously spelled this as `typeof import("@/db").db` inline at
 * each helper that needed it. Naming it keeps the domain modules readable and
 * gives the tests a single type to satisfy.
 */
export type Db = typeof import("@/db").db;
