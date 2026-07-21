export const TEST_PLAN_MARKER = 'study-assistant/node-test/v1';

function hasExplicitTestOnlyOption(options) {
  return options && typeof options === 'object' && Object.hasOwn(options, 'testOnly');
}

export function shouldMarkPlanForTestCleanup(options = {}) {
  if (hasExplicitTestOnlyOption(options)) return options.testOnly === true;
  return Boolean(process.env.NODE_TEST_CONTEXT);
}

export function markPlanForTestCleanup(plan, options = {}) {
  if (!shouldMarkPlanForTestCleanup(options)) return plan;
  plan.__testPlan = {
    marker: TEST_PLAN_MARKER,
    runner: 'node:test',
    createdAt: Date.now(),
  };
  return plan;
}

export function hasTestPlanMarker(plan) {
  return plan?.__testPlan?.marker === TEST_PLAN_MARKER;
}
