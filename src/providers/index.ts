// ─── Provider Orchestration ───────────────────────────────
// Barrel export for provider-related utilities.
//
// Architecture: AI SDK Provider Registry (ai-sdk-registry.ts) is the Provider Truth.
// Old provider implementations (base.provider.ts, implementations/) are DEPRECATED.
// This file only exports pricing (used by admin/controller.ts).

// Pricing (still used by admin dashboard)
export {
  getModelPricing,
  calculateCost,
  getAllPricing,
  getProviderPricing,
  type ModelPricing,
} from './pricing';
