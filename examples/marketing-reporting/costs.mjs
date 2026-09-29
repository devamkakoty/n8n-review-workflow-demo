export function estimateCosts({
  agencyCounts = [5, 15, 30],
  weeksPerMonth = 52 / 12,
  inputTokensPerSummary = 1500,
  outputTokensPerSummary = 250,
  inputUsdPerMillionTokens = 1,
  outputUsdPerMillionTokens = 4,
  summaryAttemptMultiplier = 1,
  platformMonthlyUsd = 0,
} = {}) {
  if (!Array.isArray(agencyCounts) || agencyCounts.length < 1 || agencyCounts.length > 10
      || Array.from(agencyCounts).some((n) => !Number.isInteger(n) || n < 1 || n > 1000)
      || new Set(agencyCounts).size !== agencyCounts.length) {
    throw new TypeError('Use 1-10 distinct agency counts, each 1-1000');
  }
  const bounded = (value, min, max) => typeof value === 'number' && Number.isFinite(value)
    && value >= min && value <= max;
  if (!bounded(weeksPerMonth, 1, 5)
      || ![inputTokensPerSummary, outputTokensPerSummary].every(
        (n) => Number.isInteger(n) && bounded(n, 0, 1_000_000),
      )
      || ![inputUsdPerMillionTokens, outputUsdPerMillionTokens, platformMonthlyUsd].every(
        (n) => bounded(n, 0, 1_000_000),
      )
      || !bounded(summaryAttemptMultiplier, 1, 10)) {
    throw new TypeError('Invalid cost assumptions');
  }
  const accountsPerAgency = 6;
  const perSummary = (inputTokensPerSummary * inputUsdPerMillionTokens
    + outputTokensPerSummary * outputUsdPerMillionTokens) / 1_000_000;
  const round = (number) => Number(number.toFixed(6));
  return {
    synthetic: true, currency: 'USD', pricing: 'illustrative_inputs_not_vendor_quotes',
    actualLlmCalls: 0, actualTokenSpendUsd: 0,
    assumptions: {
      accountsPerAgency, summariesPerAccountPerWeek: 1, weeksPerMonth,
      inputTokensPerSummary, outputTokensPerSummary,
      inputUsdPerMillionTokens, outputUsdPerMillionTokens,
      summaryAttemptMultiplier, platformMonthlyUsd,
      workflowExecutionsPerAgencyPerWeek: 1, sourceReadsPerAccountPerWeek: 2,
      platformScope: 'one shared monthly amount per scenario, not per agency',
    },
    excluded: ['taxes', 'labor', 'storage', 'ad spend', 'vendor API fees', 'pagination', 'other LLM calls'],
    perSummaryTokenCostUsd: round(perSummary),
    scenarios: agencyCounts.map((agencies) => {
      const accounts = agencies * accountsPerAgency;
      const monthlySummaries = accounts * weeksPerMonth;
      const monthlyAttempts = monthlySummaries * summaryAttemptMultiplier;
      const tokenMonthlyUsd = monthlyAttempts * perSummary;
      return {
        agencies, adAccounts: accounts, summariesPerWeek: accounts,
        summariesPerMonth: round(monthlySummaries),
        summaryAttemptsPerMonth: round(monthlyAttempts),
        workflowExecutionsPerMonth: round(agencies * weeksPerMonth),
        sourceReadsPerMonth: round(accounts * 2 * weeksPerMonth),
        inputTokensPerMonth: round(monthlyAttempts * inputTokensPerSummary),
        outputTokensPerMonth: round(monthlyAttempts * outputTokensPerSummary),
        tokenMonthlyUsd: round(tokenMonthlyUsd),
        estimatedMonthlyUsd: round(tokenMonthlyUsd + platformMonthlyUsd),
      };
    }),
  };
}
