/**
 * Plaid MCP tools — four read-only tools for querying Sterling's finances.
 *
 * All handlers return `Promise<JSONOutput>` by serialising through
 * `JSON.parse(JSON.stringify(...))` so TypeScript can verify the result
 * without fighting Plaid SDK's opaque enum types.
 */
import { Effect } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import type { JSONOutput } from "@luna/tools"
import { makePlaidClient, getAccessTokens } from "./client.js"
import type { AccountBase } from "plaid"

// ── helpers ──────────────────────────────────────────────────────────────────

/** Serialize any Plaid object to a plain JSON-safe value. */
function toJSON<T>(v: T): JSONOutput {
  return JSON.parse(JSON.stringify(v)) as JSONOutput
}

function formatBalance(acct: AccountBase) {
  return {
    id: acct.account_id,
    name: acct.name,
    official_name: acct.official_name ?? null,
    type: acct.type as string,
    subtype: (acct.subtype ?? null) as string | null,
    current: acct.balances.current,
    available: acct.balances.available ?? null,
    currency: acct.balances.iso_currency_code ?? "USD",
  }
}

// ── tools ─────────────────────────────────────────────────────────────────────

export const makePlaidTools = () => {
  const client = makePlaidClient()
  const tokens = getAccessTokens()

  const SEARCH_HINT =
    "Financial data tools — query bank account balances, transactions, recurring charges, and net worth via Plaid. Use for property finances, personal spending, or mortgage tracking."

  // ── plaid_get_accounts ────────────────────────────────────────────────────
  const getAccounts = defineTool({
    name: "plaid_get_accounts",
    description:
      "List all connected bank accounts with current balances. Returns account names, types, and available/current balances for every connected Item (Chase, SoFi, etc.).",
    inputSchema: {},
    searchHint: SEARCH_HINT,
    alwaysLoad: false,
    handler: (): Effect.Effect<JSONOutput, ToolError> =>
      Effect.tryPromise({
        try: async () => {
          const results = await Promise.all(
            tokens.map((token) =>
              client
                .accountsBalanceGet({ access_token: token })
                .then((r) => r.data.accounts.map(formatBalance)),
            ),
          )
          const accounts = results.flat()
          return toJSON({ accounts, total: accounts.length })
        },
        catch: (e) =>
          new ToolError({ tool: "plaid_get_accounts", op: "accountsBalanceGet", cause: e }),
      }),
  })

  // ── plaid_get_transactions ────────────────────────────────────────────────
  const getTransactions = defineTool({
    name: "plaid_get_transactions",
    description:
      "Fetch recent transactions across all connected accounts. Optionally filter by account name or number of days back.",
    inputSchema: {
      days: z
        .number()
        .int()
        .min(1)
        .max(730)
        .optional()
        .describe("How many days back to fetch (default 30, max 730)"),
      account_filter: z
        .string()
        .optional()
        .describe(
          "Optional partial account name to filter by, e.g. 'Chase' or 'SoFi'",
        ),
    },
    searchHint: SEARCH_HINT,
    alwaysLoad: false,
    handler: ({ days = 30, account_filter }): Effect.Effect<JSONOutput, ToolError> =>
      Effect.tryPromise({
        try: async () => {
          const end = new Date()
          const start = new Date()
          start.setDate(start.getDate() - days)
          const startStr = start.toISOString().slice(0, 10)
          const endStr = end.toISOString().slice(0, 10)

          const results = await Promise.all(
            tokens.map((token) =>
              client
                .transactionsGet({
                  access_token: token,
                  start_date: startStr,
                  end_date: endStr,
                  options: { count: 250 },
                })
                .then((r) => ({
                  accounts: r.data.accounts,
                  transactions: r.data.transactions,
                })),
            ),
          )

          let transactions = results.flatMap((r) => {
            if (!account_filter) return r.transactions
            const matchingIds = new Set(
              r.accounts
                .filter(
                  (a) =>
                    a.name.toLowerCase().includes(account_filter.toLowerCase()) ||
                    (a.official_name ?? "")
                      .toLowerCase()
                      .includes(account_filter.toLowerCase()),
                )
                .map((a) => a.account_id),
            )
            return r.transactions.filter((t) => matchingIds.has(t.account_id))
          })

          transactions = transactions.sort(
            (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
          )

          const summary = transactions.reduce(
            (acc, t) => {
              if (t.amount > 0) acc.total_spent += t.amount
              else acc.total_income += Math.abs(t.amount)
              return acc
            },
            { total_spent: 0, total_income: 0 },
          )

          const txList = transactions.map((t) => ({
            date: t.date,
            name: t.merchant_name ?? t.name,
            amount: t.amount,
            category:
              t.personal_finance_category?.primary ??
              (t.category != null ? t.category[0] ?? null : null),
            account_id: t.account_id,
            pending: t.pending,
          }))

          return toJSON({
            period: { start: startStr, end: endStr, days },
            count: transactions.length,
            total_spent: Math.round(summary.total_spent * 100) / 100,
            total_income: Math.round(summary.total_income * 100) / 100,
            transactions: txList,
          })
        },
        catch: (e) =>
          new ToolError({
            tool: "plaid_get_transactions",
            op: "transactionsGet",
            cause: e,
          }),
      }),
  })

  // ── plaid_get_recurring ───────────────────────────────────────────────────
  const getRecurring = defineTool({
    name: "plaid_get_recurring",
    description:
      "Get recurring transactions detected by Plaid — subscriptions, rent, mortgage payments, and regular income streams.",
    inputSchema: {},
    searchHint: SEARCH_HINT,
    alwaysLoad: false,
    handler: (): Effect.Effect<JSONOutput, ToolError> =>
      Effect.tryPromise({
        try: async () => {
          const itemData = await Promise.all(
            tokens.map(async (token) => {
              const acctResp = await client.accountsGet({ access_token: token })
              return {
                token,
                account_ids: acctResp.data.accounts.map((a) => a.account_id),
              }
            }),
          )

          const results = await Promise.all(
            itemData.map(({ token, account_ids }) =>
              client
                .transactionsRecurringGet({ access_token: token, account_ids })
                .then((r) => ({
                  inflows: r.data.inflow_streams,
                  outflows: r.data.outflow_streams,
                })),
            ),
          )

          const inflows = results.flatMap((r) =>
            r.inflows.map((s) => ({
              name: s.merchant_name ?? s.description,
              average_amount: s.average_amount.amount ?? null,
              frequency: s.frequency as string,
              last_date: s.last_date,
              status: s.status as string,
            })),
          )

          const outflows = results.flatMap((r) =>
            r.outflows.map((s) => ({
              name: s.merchant_name ?? s.description,
              average_amount: s.average_amount.amount ?? null,
              frequency: s.frequency as string,
              last_date: s.last_date,
              status: s.status as string,
            })),
          )

          const monthlyOutflow = outflows
            .filter((s) => s.status === "MATURE")
            .reduce((sum, s) => sum + Math.abs(s.average_amount ?? 0), 0)

          const monthlyInflow = inflows
            .filter((s) => s.status === "MATURE")
            .reduce((sum, s) => sum + Math.abs(s.average_amount ?? 0), 0)

          return toJSON({
            inflows,
            outflows,
            summary: {
              monthly_income: Math.round(monthlyInflow * 100) / 100,
              monthly_expenses: Math.round(monthlyOutflow * 100) / 100,
              net: Math.round((monthlyInflow - monthlyOutflow) * 100) / 100,
            },
          })
        },
        catch: (e) =>
          new ToolError({
            tool: "plaid_get_recurring",
            op: "transactionsRecurringGet",
            cause: e,
          }),
      }),
  })

  // ── plaid_get_net_worth ───────────────────────────────────────────────────
  const getNetWorth = defineTool({
    name: "plaid_get_net_worth",
    description:
      "Calculate net worth across all connected accounts — total assets (checking, savings, investments) minus liabilities (credit cards, loans, mortgage).",
    inputSchema: {},
    searchHint: SEARCH_HINT,
    alwaysLoad: false,
    handler: (): Effect.Effect<JSONOutput, ToolError> =>
      Effect.tryPromise({
        try: async () => {
          const results = await Promise.all(
            tokens.map((token) =>
              client
                .accountsBalanceGet({ access_token: token })
                .then((r) => r.data.accounts),
            ),
          )

          const accounts = results.flat()
          let assets = 0
          let liabilities = 0

          for (const acct of accounts) {
            const bal = acct.balances.current ?? 0
            if (acct.type === "depository" || acct.type === "investment") {
              assets += bal
            } else if (acct.type === "credit" || acct.type === "loan") {
              liabilities += bal
            }
          }

          return toJSON({
            assets: Math.round(assets * 100) / 100,
            liabilities: Math.round(liabilities * 100) / 100,
            net_worth: Math.round((assets - liabilities) * 100) / 100,
            breakdown: accounts.map((a) => ({
              name: a.name,
              type: a.type as string,
              balance: a.balances.current,
              currency: a.balances.iso_currency_code ?? "USD",
            })),
          })
        },
        catch: (e) =>
          new ToolError({
            tool: "plaid_get_net_worth",
            op: "accountsBalanceGet",
            cause: e,
          }),
      }),
  })

  return [getAccounts, getTransactions, getRecurring, getNetWorth] as const
}
