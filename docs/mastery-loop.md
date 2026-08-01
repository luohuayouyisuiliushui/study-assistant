# Personal Mastery Loop

Study Assistant 3.1 keeps the mastery loop inside each Plan JSON. It does not add an account, database, cloud service, or dependency.

## Domain State

- `masteryEvidence`: immutable scored attempts, deduplicated by `source + sourceRef`.
- `mastery`: derived from Evidence. `topic.done` and `topic.studied` never mean mastered.
- `reviewSchedule`: deterministic `sm2-v1` schedule. Opening or deferring a Review does not advance it.
- `reviewSession`: the one persisted active Review or Mistake Repair session for a Topic. Its fixed answers are projected only after submission.
- `mistakeRecords`: concept-keyed `open -> repairing -> verified` records, with explicit `dismissed` as the only alternate terminal state.

Mastery requires three high-confidence correct sessions spanning at least 24 hours. A later high-confidence error resets the successful run. Quiz and Feynman outcomes currently remain low-confidence unless a trustworthy numeric confidence is present, so they are retained without independently advancing Mastery.

Choice questions use deterministic answer-key grading. Open questions use exact-only grading: an exact normalized match is deterministic high-confidence Evidence, while a non-match is retained as low-confidence AI-graded Evidence and cannot lapse the schedule, reset Mastery, or create another Mistake Record. This keeps open-answer paraphrases from becoming false high-confidence errors.

## Today Review

`GET /api/learn/today-review` builds one cross-Plan queue item per Topic. The default local budget is 30 minutes and the UI persists a user-selected 10–120 minute value. Ordering is open mistake, due repairing record, overdue Review, then Review due now.

Review API operations live below `/api/learn/plans/:planId/topics/:topicId/`. They create or resume a session, submit its exact question set, defer the Topic, start Mistake Repair, or explicitly dismiss an actionable Mistake Record. Exam mistakes reuse their persisted source questions when no matching Topic exercise exists. Verified records are terminal; repeated dismissal is idempotent.

## Backup And Metrics

`GET /api/learn/mastery/backup` returns a versioned `study-assistant-backup-v1` document containing every active Plan and its Evidence, schedules, sessions, and Mistake Records. `POST /api/learn/mastery/restore/preview` validates nested state and counts changes without writing. Restore requires `confirm: true`, holds all affected Plan write queues, merges index entries under the index mutex, and rolls Plan files, index entries, and backup artifacts back on failure.

`GET /api/learn/mastery/metrics?budgetMinutes=30` recomputes Review completion rate, overdue age, open-to-verified repair time, duplicate Evidence, and Topics outside the selected 10–120 minute daily budget from local Plan data.
