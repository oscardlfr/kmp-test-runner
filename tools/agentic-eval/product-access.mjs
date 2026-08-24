#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/product-access.mjs -- closed vocabulary for whether the evaluated agent had
// access to the kmp-test-runner product surface. This is deliberately separate from `condition`:
// condition is the skill-treatment axis (`current-skill` vs. `no-skill`), while product access
// says whether the product CLI/knowledge was available at all.

export const PRODUCT_ACCESS_MODE_VALUES = Object.freeze([
  'product-assisted',
  'product-visible-no-skill',
  'free-baseline-no-product',
  'contaminated-baseline',
  'product-access-not-recorded',
]);

export const PRODUCT_USAGE_MODE_VALUES = Object.freeze([
  'product-cli',
  'direct-build-tool',
  'mixed-product-and-build-tool',
  'manual-other',
  'none',
]);

export function productAccessModeForSkillCondition(condition) {
  if (condition === 'current-skill' || condition === 'candidate-skill') return 'product-assisted';
  if (condition === 'no-skill') return 'product-visible-no-skill';
  return 'product-access-not-recorded';
}

export function isProductAccessMode(value) {
  return PRODUCT_ACCESS_MODE_VALUES.includes(value);
}
