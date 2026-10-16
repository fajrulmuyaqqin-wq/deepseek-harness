/**
 * Mesin kalkulasi biaya model dan markup margin keuntungan untuk Boson Gateway.
 */

import type { ModelPricing } from './types.ts'

export const DEFAULT_PRICING_CATALOG: Record<string, ModelPricing> = {
  'deepseek/deepseek-chat': {
    modalPromptPer1M: 0.14,
    modalCompletionPer1M: 0.28,
    defaultMarkupPercent: 30, // Margin keuntungan Anda: +30%
  },
  'deepseek-v3': {
    modalPromptPer1M: 0.14,
    modalCompletionPer1M: 0.28,
    defaultMarkupPercent: 30,
  },
  'deepseek/deepseek-r1': {
    modalPromptPer1M: 0.55,
    modalCompletionPer1M: 2.19,
    defaultMarkupPercent: 30,
  },
  'deepseek-r1': {
    modalPromptPer1M: 0.55,
    modalCompletionPer1M: 2.19,
    defaultMarkupPercent: 30,
  },
  'anthropic/claude-3.5-sonnet': {
    modalPromptPer1M: 3.00,
    modalCompletionPer1M: 15.00,
    defaultMarkupPercent: 25,
  },
  'claude-3-5-sonnet': {
    modalPromptPer1M: 3.00,
    modalCompletionPer1M: 15.00,
    defaultMarkupPercent: 25,
  },
}

export class PricingEngine {
  private catalog: Map<string, ModelPricing>

  constructor(customCatalog?: Record<string, ModelPricing>) {
    this.catalog = new Map(Object.entries(customCatalog ?? DEFAULT_PRICING_CATALOG))
  }

  /**
   * Menghitung modal aktual ke OpenRouter berdasarkan tokens.
   */
  public calculateActualCost(model: string, promptTokens: number, completionTokens: number): number {
    const pricing = this.catalog.get(model) ?? {
      modalPromptPer1M: 0.50,
      modalCompletionPer1M: 1.50,
      defaultMarkupPercent: 30,
    }

    return (
      (promptTokens * pricing.modalPromptPer1M + completionTokens * pricing.modalCompletionPer1M) /
      1_000_000
    )
  }

  /**
   * Menghitung harga jual ke tenant berdasarkan markup.
   * Jika upstream OpenRouter mengembalikan biaya aktual (actualCostUsd), gunakan biaya tersebut!
   */
  public calculateBilledCost(
    model: string,
    actualCostUsd: number,
    customMarkupPercent?: number,
  ): { billedCostUsd: number; profitUsd: number; markupPercent: number } {
    const pricing = this.catalog.get(model)
    const markupPercent = customMarkupPercent ?? pricing?.defaultMarkupPercent ?? 30
    const billedCostUsd = actualCostUsd * (1 + markupPercent / 100)
    const profitUsd = billedCostUsd - actualCostUsd

    return {
      billedCostUsd,
      profitUsd,
      markupPercent,
    }
  }
}
