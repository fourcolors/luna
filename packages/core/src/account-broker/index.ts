export {
  AccountBroker,
  type AccountBrokerApi,
  type AccountSeed,
  type AccountSummary,
  type AccountError,
  type Credential,
  type AcquiredSession,
  type UsageReport,
} from "./account-broker.js"
export { pickAccount, type AccountRecord } from "./rotation-policy.js"
export {
  applyUsage,
  readCycleMs,
  type SpendUpdate,
  type UsageTokens,
} from "./spend-meter.js"
export type { FromSqlOptions } from "./account-broker-sql.js"

import { AccountBrokerLayer as InMemoryLayer } from "./account-broker.js"
import { fromSql } from "./account-broker-sql.js"

/**
 * Layer factories for AccountBroker.
 *  - `fromAccounts(seeds)`  — Phase 9 in-memory seed (account-broker.ts)
 *  - `fromSql({ dbPath? })` — Phase 25a SQL hydration (account-broker-sql.ts)
 *
 * Both return the same `AccountBrokerApi` — callers cannot tell which
 * factory built the broker (§7.5 invariant).
 */
export const AccountBrokerLayer = {
  ...InMemoryLayer,
  fromSql,
} as const

export {
  validateAccountKind,
  validateAccountSecretRef,
  accountSecretRefError,
  FILE_SECRET_REF_ERROR,
} from "./account-refs.js"
export {
  validateAccountAddInput,
  listAccountsFromDb,
  addAccountToDb,
  removeAccountFromDb,
  type AccountManageRow,
  type AccountManageResult,
  type AccountManageDb,
  type AccountAddInput,
} from "./account-manage.js"
