/**
 * SM-2 Spaced Repetition Algorithm Implementation
 * Author: Based on the original SM-2 algorithm by Ankit Panda
 * Description: Implements spaced repetition scheduling based on review performance
 * Reference: https://apps.ict.nu/~marc/games/sm2.html
 */

import { getPlan, updateTopic } from './learn-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * SM-2 Algorithm Parameters
 * These parameters control the spacing of review sessions
 */
const SM2_PARAMS = {
  // Initial spacing (days)
  INITIAL_EASEFACTOR: 2.5,
  // Maximum ease factor
  MAX_EASEFACTOR: 2.5,
  // Minimum ease factor
  MIN_EASEFACTOR: 1.3,
  // Minimum interval (days)
  MIN_INTERVAL: 1,
  // Hardening factor (applied when review fails)
  FAIL_HARDENING: 0,
  // Maximum interval (days)
  MAX_INTERVAL: 36500, // ~100 years
};

/**
 * SM-2 Grade Mapping
 * Maps review performance to quality ratings (0-5)
 * Based on the original SM-2 scoring system
 */
const GRADE_MAPPING = {
  perfect: 5, // Correct answer confidently
  correct: 4, // Correct answer
  close: 3,   // Correct answer with some hesitation
  fail: 2,    // Incorrect answer but recallable
  guess: 1,   // Guessing wrong (guess)
  unprepared: 0, // No recollection
};

/**
 * Calculate next review interval using SM-2 algorithm
 * Based on: https://en.wikipedia.org/wiki/Spaced_repetition#The_SM-2_algorithm
 *
 * @param {number} quality - Quality rating (0-5) from GRADE_MAPPING
 * @param {number} easeFactor - Current ease factor (1.3-2.5)
 * @param {number} intervalsPassed - Number of intervals that have passed since last review
 * @returns {object} - {interval, easeFactor, grade} next review details
 */
export function calculateNextReview(quality, easeFactor, intervalsPassed = 0) {
  // Input validation
  if (typeof quality !== 'number' || quality < 0 || quality > 5) {
    throw new Error('Quality rating must be a number between 0 and 5');
  }

  const normalizedEaseFactor = Number.isFinite(easeFactor)
    ? Math.max(SM2_PARAMS.MIN_EASEFACTOR, Math.min(SM2_PARAMS.MAX_EASEFACTOR, easeFactor))
    : SM2_PARAMS.INITIAL_EASEFACTOR;
  const elapsedIntervals = Number.isFinite(intervalsPassed) ? Math.max(0, intervalsPassed) : 0;

  // Calculate new ease factor based on quality
  const qualityDifference = 5 - quality;
  const easeAdjustment = 0.1 - qualityDifference * (0.08 + qualityDifference * 0.02);
  const newEaseFactor = normalizedEaseFactor + easeAdjustment;

  // Apply minimum and maximum constraints
  const maxNewEaseFactor = Math.min(newEaseFactor, SM2_PARAMS.MAX_EASEFACTOR);
  const minNewEaseFactor = Number(Math.max(maxNewEaseFactor, SM2_PARAMS.MIN_EASEFACTOR).toFixed(2));

  // Calculate interval based on quality and ease factor
  let interval;

  if (quality < 3) {
    // For poor quality (0-2): use harder timing, review sooner
    // Formula: interval = 1 day * hard factor ^ (3 - quality)
    const hardFactor = 1 + SM2_PARAMS.FAIL_HARDENING * (3 - quality);
    interval = 1 * Math.pow(hardFactor, 3 - quality);
  } else {
    // For good quality (3-5): use original SM-2 formula
    // Formula: interval = previous interval * ease factor ^ (quality - 3)
    interval = Math.max(1, elapsedIntervals * Math.pow(minNewEaseFactor, quality - 3));
  }

  // Apply constraints
  interval = Math.round(Math.max(SM2_PARAMS.MIN_INTERVAL, Math.min(interval, SM2_PARAMS.MAX_INTERVAL)));

  return {
    interval: interval,
    easeFactor: minNewEaseFactor,
    grade: Math.round(quality),
    algorithm: 'SM-2',
  };
}

/**
 * Calculate SM-2 scheduled reviews for a topic
 * Given review history, calculates next review time
 *
 * @param {object} topic - Topic object with review history
 * @param {Date} currentDate - Current date for calculation
 * @returns {object} - Next review details
 */
export function calculateSm2Schedule(topic, currentDate = new Date()) {
  if (!(currentDate instanceof Date) || Number.isNaN(currentDate.getTime())) {
    throw new Error('currentDate must be a valid Date');
  }

  // Extract review history from topic
  const reviewHistory = topic.sm2History || topic.reviewHistory || [];

  if (!reviewHistory.length) {
    // First review ever - use initial parameters
    return {
      nextReview: new Date(currentDate.getTime() + SM2_PARAMS.INITIAL_EASEFACTOR * DAY_MS),
      easeFactor: SM2_PARAMS.INITIAL_EASEFACTOR,
      grade: null,
      algorithm: 'SM-2 Initial',
    };
  }

  // Calculate based on last review
  const lastReview = reviewHistory[reviewHistory.length - 1];
  const intervalsPassed = Math.max(0, Math.floor((currentDate - new Date(lastReview.reviewDate)) / DAY_MS));

  // Calculate next review
  const nextReviewDetails = calculateNextReview(
    lastReview.grade ?? 3, // Default to 'close' if no grade
    lastReview.easeFactor ?? SM2_PARAMS.INITIAL_EASEFACTOR,
    intervalsPassed
  );

  return {
    nextReview: new Date(currentDate.getTime() + nextReviewDetails.interval * DAY_MS),
    easeFactor: nextReviewDetails.easeFactor,
    grade: nextReviewDetails.grade,
    algorithm: 'SM-2',
    history: reviewHistory,
  };
}

/**
 * Record a review using SM-2 algorithm
 * Updates topic with SM-2 review history and calculates next review
 *
 * @param {string} planId - Plan ID
 * @param {string} topicId - Topic ID
 * @param {number} quality - Review quality (0-5)
 * @param {string} reviewType - Type of review (manual/auto)
 * @param {Date} currentDate - Optional review timestamp for deterministic scheduling
 * @returns {Promise<object>} - Updated topic with next review scheduled
 */
export async function recordSm2Review(planId, topicId, quality, reviewType = 'manual', currentDate = new Date()) {
  // Validate quality
  if (typeof quality !== 'number' || quality < 0 || quality > 5) {
    throw new Error('Review quality must be a number between 0 and 5');
  }

  if (!(currentDate instanceof Date) || Number.isNaN(currentDate.getTime())) {
    throw new Error('currentDate must be a valid Date');
  }

  const plan = getPlan(planId);
  if (!plan) {
    throw new Error('Plan not found');
  }

  const topic = plan.topics?.find(candidate => candidate.id === topicId);
  if (!topic) {
    throw new Error('Topic not found');
  }

  const history = Array.isArray(topic.sm2History) ? [...topic.sm2History] : [];
  const now = new Date(currentDate.getTime());
  const reviewRecord = {
    reviewDate: now.toISOString(),
    quality: quality,
    grade: GRADE_MAPPING[Math.floor(quality)] ?? Math.floor(quality),
    easeFactor: history.length ? history[history.length - 1].easeFactor : SM2_PARAMS.INITIAL_EASEFACTOR,
    reviewType: reviewType,
    algorithm: 'SM-2',
  };

  // Add to history
  history.push(reviewRecord);

  // Keep only last 100 reviews to prevent unlimited growth
  const sm2History = history.slice(-100);

  // Calculate next review
  const nextReviewDetails = calculateNextReview(
    reviewRecord.grade,
    reviewRecord.easeFactor,
    0
  );

  // Update topic with new review and next review info
  const updateData = {
    sm2History,
    nextReviewDate: nextReviewDetails.interval > 0
      ? new Date(now.getTime() + nextReviewDetails.interval * DAY_MS).toISOString()
      : null,
    sm2EaseFactor: nextReviewDetails.easeFactor,
    sm2NextInterval: nextReviewDetails.interval,
  };

  // Update topic in database
  await updateTopic(planId, topicId, updateData);

  return {
    success: true,
    review: reviewRecord,
    nextReview: nextReviewDetails,
    algorithm: 'SM-2',
  };
}

/**
 * Get SM-2 review statistics for a topic
 * Calculates performance metrics based on review history
 *
 * @param {object} topic - Topic with SM-2 history
 * @returns {object} - SM-2 statistics
 */
export function getSm2Statistics(topic) {
  const history = topic.sm2History || [];

  if (!history.length) {
    return {
      totalReviews: 0,
      averageGrade: 0,
      easeFactorTrend: 0,
      retentionRate: 0,
      scheduleCompliance: 0,
    };
  }

  const grades = history.map(r => r.grade);
  const easeFactors = history.map(r => r.easeFactor);

  const averageGrade = grades.reduce((sum, grade) => sum + grade, 0) / grades.length;
  const averageEaseFactor = easeFactors.reduce((sum, ef) => sum + ef, 0) / easeFactors.length;

  // Calculate retention rate (grades >= 3 indicate retention)
  const retainedReviews = grades.filter(grade => grade >= 3).length;
  const retentionRate = grades.length > 0 ? (retainedReviews / grades.length) * 100 : 0;

  // Calculate schedule compliance (reviews within scheduled interval)
  const scheduleCompliance = calculateScheduleCompliance(topic);

  return {
    totalReviews: history.length,
    averageGrade: Math.round(averageGrade * 10) / 10,
    easeFactorTrend: averageEaseFactor,
    retentionRate: Math.round(retentionRate * 10) / 10,
    scheduleCompliance: Math.round(scheduleCompliance * 10) / 10,
    lastReviewDate: history[history.length - 1].reviewDate,
    nextReviewDate: topic.nextReviewDate,
  };
}

/**
 * Calculate schedule compliance rate
 * Measures how well users follow the scheduled reviews
 *
 * @param {object} topic - Topic with SM-2 history
 * @returns {number} Schedule compliance rate (0-1)
 */
function calculateScheduleCompliance(topic) {
  if (!topic.sm2History || topic.sm2History.length < 2) {
    return 1.0; // Perfect compliance for first review
  }

  const history = topic.sm2History;
  let complianceCount = 0;

  for (let i = 1; i < history.length; i++) {
    const currentReview = history[i];
    const previousReview = history[i - 1];

    const actualInterval = new Date(currentReview.reviewDate) - new Date(previousReview.reviewDate);
    const expectedInterval = currentReview.expectedInterval || SM2_PARAMS.INITIAL_EASEFACTOR * 24 * 60 * 60 * 1000;

    // Check if review was within 25% tolerance of expected interval
    const tolerance = expectedInterval * 0.25;
    if (Math.abs(actualInterval - expectedInterval) <= tolerance) {
      complianceCount++;
    }
  }

  return history.length > 1 ? complianceCount / (history.length - 1) : 1.0;
}

/**
 * Get topics due for review today
 * Filters topics scheduled for review based on SM-2 algorithm
 *
 * @param {Array} topics - Array of topics
 * @param {Date} currentDate - Current date
 * @returns {Array} - Topics due for review today
 */
export function getTopicsDueForReview(today, topics) {
  if (!Array.isArray(topics)) {
    return [];
  }

  return topics
    .filter(topic => topic.sm2History && topic.sm2History.length > 0)
    .filter(topic => {
      const lastReview = topic.sm2History[topic.sm2History.length - 1];
      const lastReviewDate = new Date(lastReview.reviewDate);
      const daysSinceReview = Math.floor((today - lastReviewDate) / (24 * 60 * 60 * 1000));

      // Check if topic is due for review based on SM-2 schedule
      return daysSinceReview >= (topic.sm2NextInterval || SM2_PARAMS.INITIAL_EASEFACTOR);
    })
    .map(topic => ({
      id: topic.id,
      title: topic.title,
      planId: topic.planId,
      difficulty: topic.difficulty || 'intermediate',
      subject: topic.subject || 'General',
      lastReview: topic.sm2History[topic.sm2History.length - 1],
      nextReviewDue: topic.nextReviewDate,
      easeFactor: topic.sm2EaseFactor,
      schedulingAlgorithm: 'SM-2',
    }));
}

// Export all SM-2 related functions
export default {
  calculateNextReview,
  calculateSm2Schedule,
  recordSm2Review,
  getSm2Statistics,
  getTopicsDueForReview,
  GRADE_MAPPING,
  SM2_PARAMS,
};
