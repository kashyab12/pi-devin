export interface UsageMetrics {
  promptTokens?: number;
  completionTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * Calculate the complete context token count from Devin's split usage metrics.
 * Cache tokens are reported separately but still occupy the model context.
 */
export function calculateUsageTotal(usage: UsageMetrics): number {
  return (
    (usage.promptTokens ?? 0) +
    (usage.completionTokens ?? 0) +
    (usage.cachedInputTokens ?? 0) +
    (usage.cacheCreationInputTokens ?? 0)
  );
}
