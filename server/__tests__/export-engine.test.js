import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  exportPlanBundle,
  generateAnkiCSV,
  generateNotionCSV,
  generateOPML,
  generateStudyNotes,
  generateTopicJSON,
} from '../engine/export-engine.js';

const DETAIL = `# TCP & Routing

## Core <Concept>

TCP preserves ordered delivery.

### Port "Facts"

- **Port**: 443

## 📝 练习题

> **练习题 1** (选择题) Which protocol uses "ordered" delivery?
> - A. UDP
> - B. TCP
> - C. ICMP
> - D. ARP
> > 正确答案: B
> > 解析: TCP preserves order.
> > 关联概念: Transport layer
`;

const PLAN = {
  id: 'plan-1',
  name: 'Network, "Fundamentals"',
  createdAt: 100,
  updatedAt: 200,
  phases: [{ name: 'Foundation', order: 1 }],
  examPapers: [{ id: 'exam-1' }, { id: 'exam-2' }],
  topics: [
    {
      id: 'topic-1',
      title: 'TCP & <XML> "Topic"',
      detail: DETAIL,
      difficulty: 'medium',
      done: true,
      timeSpent: 120,
      level: 2,
      phaseId: 'phase-1',
      parentId: null,
      exercises: [{
        id: 'stored-exercise',
        type: 'choice',
        question: 'Stored question',
        options: ['A. UDP', 'B. TCP'],
        answer: 'B',
        explanation: 'Stored explanation',
        conceptTag: 'Transport layer',
        userAnswer: 'A',
        correct: false,
      }],
      weakPoints: ['Routing'],
      teachingErrors: [{
        location: 'paragraph 1',
        description: 'Confuses ports and protocols',
        errorType: 'conceptual',
        misconception: 'Port equals protocol',
        recognized: false,
      }],
      factCheck: { trusted: true },
      reviewGenerated: 'Review this topic.',
      feynmanInsights: { teachingQuality: 'good' },
    },
    {
      id: 'topic-2',
      title: 'Empty topic',
      detail: '',
      done: false,
      exercises: [],
      weakPoints: [],
    },
  ],
  history: [
    { topicId: 'topic-1', role: 'user', content: 'Why is TCP reliable?', timestamp: 10 },
    { topicId: 'topic-1', role: 'ai', content: 'It acknowledges ordered bytes.', timestamp: 11 },
    { topicId: 'topic-1', role: 'user', content: 'Unanswered follow-up', timestamp: 12 },
    { topicId: 'topic-1', role: 'user', content: 'Second paired question', timestamp: 13 },
    { topicId: 'topic-1', role: 'ai', content: 'Second paired answer', timestamp: 14 },
    { topicId: 'topic-2', role: 'user', content: 'Other topic question', timestamp: 15 },
  ],
};

describe('export-engine', () => {
  it('returns stable empty values for missing Plans, Topics, and Details', () => {
    assert.equal(generateAnkiCSV(null, 'topic-1'), '');
    assert.equal(generateAnkiCSV(PLAN, 'missing'), '');
    assert.equal(generateAnkiCSV(PLAN, 'topic-2'), '');
    assert.equal(generateOPML(null, 'topic-1'), '');
    assert.equal(generateOPML(PLAN, 'missing'), '');
    assert.equal(generateNotionCSV(null), '');
    assert.equal(generateTopicJSON(null, 'topic-1'), null);
    assert.equal(generateTopicJSON(PLAN, 'missing'), null);
    assert.equal(generateStudyNotes(null, 'topic-1'), '');
    assert.equal(generateStudyNotes(PLAN, 'topic-2'), '');
    assert.equal(exportPlanBundle(null), null);
  });

  it('generates Anki CSV with escaped values, parsed exercises, and paired Q&A', () => {
    const csv = generateAnkiCSV(PLAN, 'topic-1');

    assert.ok(csv.startsWith('\uFEFFType,Front,Back,Tags,Extra'));
    assert.match(csv, /Which protocol uses ""ordered"" delivery\?/);
    assert.match(csv, /<b>答案：B<\/b>/);
    assert.match(csv, /UDP<br>TCP<br>ICMP<br>ARP/);
    assert.match(csv, /Why is TCP reliable\?/);
    assert.match(csv, /It acknowledges ordered bytes\./);
    assert.match(csv, /Second paired question/);
    assert.doesNotMatch(csv, /Unanswered follow-up/);
  });

  it('generates escaped OPML outlines with section content', () => {
    const opml = generateOPML(PLAN, 'topic-1');

    assert.match(opml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(opml, /<title>TCP &amp; &lt;XML&gt; &quot;Topic&quot;<\/title>/);
    assert.match(opml, /<outline text="Core &lt;Concept&gt;">/);
    assert.match(opml, /<outline text="Port &quot;Facts&quot;" _note="- \*\*Port\*\*: 443"\/>/);
  });

  it('generates Notion CSV for all topics with CSV escaping and review status', () => {
    const csv = generateNotionCSV(PLAN);

    assert.ok(csv.startsWith('\uFEFFTitle,Status,Difficulty,Tags,Summary,Detail Excerpt,Weak Points,Review'));
    assert.match(csv, /"TCP & <XML> ""Topic""","已完成","medium"/);
    assert.match(csv, /"Routing","需要复习"/);
    assert.match(csv, /"Empty topic","待学习"/);
  });

  it('generates structured topic JSON with stored exercises and only paired Q&A', () => {
    const exported = generateTopicJSON(PLAN, 'topic-1');

    assert.match(exported.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(exported.planName, PLAN.name);
    assert.deepEqual(exported.topic, {
      id: 'topic-1',
      title: 'TCP & <XML> "Topic"',
      difficulty: 'medium',
      done: true,
      timeSpent: 120,
      level: 2,
      phaseId: 'phase-1',
      parentId: null,
    });
    assert.equal(exported.exercises.length, 1);
    assert.equal(exported.exercises[0].correctAnswer, 'B');
    assert.equal(exported.content.codeBlocks.length, 0);
    assert.deepEqual(exported.content.keyFacts, [{ key: 'Port', value: '443' }]);
    assert.deepEqual(exported.qaHistory.map(({ question, answer }) => ({ question, answer })), [
      { question: 'Why is TCP reliable?', answer: 'It acknowledges ordered bytes.' },
      { question: 'Second paired question', answer: 'Second paired answer' },
    ]);
    assert.deepEqual(exported.factCheck, { trusted: true });
  });

  it('generates self-contained Markdown notes from parsed exercises and Q&A', () => {
    const notes = generateStudyNotes(PLAN, 'topic-1');

    assert.match(notes, /^---\ntitle: "TCP & <XML> "Topic""/);
    assert.match(notes, /## 📝 练习题答案/);
    assert.match(notes, /### 1\. Which protocol uses "ordered" delivery\?/);
    assert.match(notes, /\*\*答案\*\*: B/);
    assert.match(notes, /## 💬 扩展讨论/);
    assert.match(notes, /### Q1: Why is TCP reliable\?/);
    assert.doesNotMatch(notes, /Unanswered follow-up/);
  });

  it('exports plan bundle aggregates without reading storage or the network', () => {
    const bundle = exportPlanBundle(PLAN);

    assert.match(bundle.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(bundle.plan, {
      id: 'plan-1',
      name: 'Network, "Fundamentals"',
      createdAt: 100,
      updatedAt: 200,
      topicCount: 2,
      completedTopics: 1,
      phases: [{ name: 'Foundation', order: 1 }],
    });
    assert.deepEqual(bundle.topics, [
      {
        id: 'topic-1',
        title: 'TCP & <XML> "Topic"',
        done: true,
        difficulty: 'medium',
        level: 2,
        timeSpent: 120,
        hasDetail: true,
        exerciseCount: 1,
        correctExercises: 0,
        weakPointCount: 1,
        hasReview: true,
      },
      {
        id: 'topic-2',
        title: 'Empty topic',
        done: false,
        difficulty: null,
        level: 1,
        timeSpent: 0,
        hasDetail: false,
        exerciseCount: 0,
        correctExercises: 0,
        weakPointCount: 0,
        hasReview: false,
      },
    ]);
    assert.equal(bundle.examCount, 2);
    assert.equal(bundle.totalQuestions, 4);
    assert.equal(bundle.version, '1.6.0');
  });
});
