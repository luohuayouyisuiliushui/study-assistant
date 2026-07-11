import sqlite3, json

conn = sqlite3.connect(r'C:\Users\wjl14\.local\share\mimocode\mimocode.db')
c = conn.cursor()

pid = '9423f00d-1fd6-485a-9d04-e9671b61a2c0'

print("=== SESSIONS ===")
c.execute("SELECT id, title, time_created FROM session WHERE project_id = ? ORDER BY time_created DESC", (pid,))
for row in c.fetchall():
    print(json.dumps({"id": row[0], "title": row[1], "time": row[2]}))

# Get user messages with keywords for durable knowledge discovery
print("\n=== USER MESSAGES (keywords) ===")
c.execute("""
SELECT s.id as session_id, s.title, substr(m.data, 1, 500) as msg_data, m.time_created
FROM message m
JOIN session s ON s.id = m.session_id
WHERE s.project_id = ?
  AND json_extract(m.data, '$.role') = 'user'
  AND (
    m.data LIKE '%always%' OR m.data LIKE '%never%' OR m.data LIKE '%remember%'
    OR m.data LIKE '%规则%' OR m.data LIKE '%不要%' OR m.data LIKE '%必须%'
    OR m.data LIKE '%decision%' OR m.data LIKE '%decided%'
    OR m.data LIKE '%决定%' OR m.data LIKE '%方案%'
  )
ORDER BY m.time_created DESC
""", (pid,))
for row in c.fetchall():
    msg = (row[2] or "")[:300]
    print(json.dumps({"session": row[0], "title": row[1], "msg": msg, "time": row[3]}))

# Check for repeated error patterns
print("\n=== TOOL ERRORS (repeated) ===")
c.execute("""
SELECT substr(json_extract(p.data, '$.state.output'), 1, 200) as err_preview, count(*) as cnt
FROM part p
JOIN message m ON m.id = p.message_id
JOIN session s ON s.id = m.session_id
WHERE s.project_id = ?
  AND json_extract(p.data, '$.type') = 'tool'
  AND p.data LIKE '%error%'
GROUP BY err_preview
HAVING cnt > 1
ORDER BY cnt DESC
LIMIT 20
""", (pid,))
for row in c.fetchall():
    ep = (row[0] or "")[:200]
    print(json.dumps({"error_preview": ep, "count": row[1]}))

# Check subagent activity
print("\n=== SUBAGENT ACTIVITY ===")
c.execute("""
SELECT m.agent_id, count(*) as msg_count, s.id as session_id
FROM message m
JOIN session s ON s.id = m.session_id
WHERE s.project_id = ? AND m.agent_id != ''
GROUP BY m.agent_id, s.id
ORDER BY msg_count DESC
""", (pid,))
for row in c.fetchall():
    print(json.dumps({"agent": row[0], "msgs": row[1], "session": row[2]}))

# Get assistant tool calls related to fixes
print("\n=== ASSISTANT TOOL CALLS (crud.js / learn-engine.js / learn.js) ===")
c.execute("""
SELECT m.session_id, json_extract(p.data, '$.tool') as tool,
       substr(json_extract(p.data, '$.state.input'), 1, 300) as input_preview,
       m.time_created
FROM part p
JOIN message m ON m.id = p.message_id
JOIN session s ON s.id = m.session_id
WHERE s.project_id = ?
  AND json_extract(m.data, '$.role') = 'assistant'
  AND json_extract(p.data, '$.type') = 'tool'
  AND (
    p.data LIKE '%crud.js%' OR p.data LIKE '%learn-engine.js%'
    OR p.data LIKE '%learn.js%' OR p.data LIKE '%user-profile.js%'
    OR p.data LIKE '%learn-prompts.js%'
  )
ORDER BY m.time_created DESC
LIMIT 30
""", (pid,))
for row in c.fetchall():
    inp = (row[2] or "")[:250]
    print(json.dumps({"session": row[0], "tool": row[1], "input": inp, "time": row[3]}))

# Verify file existence
print("\n=== FILE CHECKS ===")
import os
files_to_check = [
    "D:/study-assistant/server/engine/store/crud.js",
    "D:/study-assistant/server/engine/learn-engine.js",
    "D:/study-assistant/server/engine/learn-prompts.js",
    "D:/study-assistant/server/engine/user-profile.js",
    "D:/study-assistant/server/routes/learn.js",
    "D:/study-assistant/server/__tests__/data-consistency.test.js",
    "D:/study-assistant/server/__tests__/edge-cases.test.js",
    "D:/study-assistant/server/__tests__/route-integration.test.js",
    "D:/study-assistant/docs/compose/reports/security-audit.md",
]
for f in files_to_check:
    exists = os.path.exists(f)
    size = os.path.getsize(f) if exists else 0
    print(json.dumps({"file": f.split("/")[-1], "exists": exists, "size": size}))

conn.close()
