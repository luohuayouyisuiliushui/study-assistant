const REVIEW_BUDGET_KEY = 'study-assistant.review-budget-minutes';

function clampBudget(value) {
  if (value === null || value === undefined || value === '') return 30;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 30;
  return Math.max(10, Math.min(120, Math.round(parsed)));
}

export function readReviewBudget() {
  if (typeof localStorage === 'undefined') return 30;
  return clampBudget(localStorage.getItem(REVIEW_BUDGET_KEY));
}

export function writeReviewBudget(value) {
  const budget = clampBudget(value);
  if (typeof localStorage !== 'undefined') localStorage.setItem(REVIEW_BUDGET_KEY, String(budget));
  return budget;
}
