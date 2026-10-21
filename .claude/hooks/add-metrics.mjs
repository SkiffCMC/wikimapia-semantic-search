#!/usr/bin/env node
// Token and timing metrics for the ADD subagents.
//   record  - SubagentStop hook (see .claude/settings.json). Reads the finished subagent's transcript
//             and appends one line to .add/reports/add-metrics.jsonl. Never blocks: always exits 0.
//   report  - node .claude/hooks/add-metrics.mjs report [feature]
//             Prints totals per feature, step and agent.
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG = path.join(root, '.add', 'reports', 'add-metrics.jsonl');

const readJsonl = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');

function findTranscript(input) {
  if (input.agent_transcript_path && fs.existsSync(input.agent_transcript_path)) {
    return input.agent_transcript_path;
  }
  if (!input.transcript_path || !input.agent_id) return null;
  const dir = path.join(input.transcript_path.replace(/\.jsonl$/, ''), 'subagents');
  const file = path.join(dir, `agent-${input.agent_id}.jsonl`);
  return fs.existsSync(file) ? file : null;
}

function summarize(entries) {
  // One API response is split into several entries (one per content block) that repeat the
  // same usage, so count each message id once, keeping the last entry seen.
  const byId = new Map();
  const tools = {};
  for (const e of entries) {
    if (e.type !== 'assistant' || !e.message) continue;
    byId.set(e.message.id ?? e.uuid, e.message);
    for (const c of e.message.content ?? []) {
      if (c.type === 'tool_use') tools[c.name] = (tools[c.name] ?? 0) + 1;
    }
  }
  const tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const models = new Set();
  for (const m of byId.values()) {
    const u = m.usage ?? {};
    tokens.input += u.input_tokens ?? 0;
    tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
    tokens.cacheRead += u.cache_read_input_tokens ?? 0;
    tokens.output += u.output_tokens ?? 0;
    if (m.model) models.add(m.model);
  }
  const times = entries.map((e) => Date.parse(e.timestamp)).filter(Number.isFinite);
  const start = times.length ? Math.min(...times) : null;
  const end = times.length ? Math.max(...times) : null;

  // The orchestrator opens every task prompt with ADD-* tag lines (see the add skill).
  const prompt = textOf(entries.find((e) => e.type === 'user')?.message?.content);
  const tag = (name) => prompt.match(new RegExp(`^ADD-${name}:\\s*(.+)$`, 'mi'))?.[1].trim() ?? null;

  return {
    feature: tag('Feature'),
    step: tag('Step'),
    attempt: Number(tag('Attempt')) || 1,
    startedAt: start && new Date(start).toISOString(),
    durationMs: start && end ? end - start : null,
    apiCalls: byId.size,
    toolCalls: tools,
    tokens,
    models: [...models],
  };
}

async function record() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const agent = input.agent_type ?? null;
  if (!agent?.startsWith('add-')) return;

  const transcript = findTranscript(input);
  const row = {
    recordedAt: new Date().toISOString(),
    agent,
    agentId: input.agent_id ?? null,
    sessionId: input.session_id ?? null,
    ...(transcript ? summarize(readJsonl(transcript)) : { error: 'subagent transcript not found' }),
  };
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${JSON.stringify(row)}\n`);
}

function report(feature) {
  if (!fs.existsSync(LOG)) {
    console.log(`No metrics yet (${path.relative(root, LOG)} does not exist).`);
    return;
  }
  const rows = readJsonl(LOG).filter((r) => !feature || r.feature === feature);
  if (!rows.length) {
    console.log(`No metrics for feature "${feature}".`);
    return;
  }
  const k = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : String(n));
  const dur = (ms) => {
    const s = Math.round(ms / 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return s >= 3600 ? `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m` : `${Math.floor(s / 60)}m${pad(s % 60)}s`;
  };
  const groups = new Map();
  for (const r of rows) {
    const key = [r.feature ?? '(untagged)', r.step ?? '-', r.agent].join('\u0000');
    const g = groups.get(key) ?? { runs: 0, ms: 0, api: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    g.runs += 1;
    g.ms += r.durationMs ?? 0;
    g.api += r.apiCalls ?? 0;
    for (const t of ['input', 'cacheWrite', 'cacheRead', 'output']) g[t] += r.tokens?.[t] ?? 0;
    groups.set(key, g);
  }
  const header = ['feature', 'step', 'agent', 'runs', 'time', 'api', 'input', 'cache write', 'cache read', 'output'];
  const table = [header];
  const total = { runs: 0, ms: 0, api: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const [key, g] of groups) {
    table.push([...key.split('\u0000'), g.runs, dur(g.ms), g.api, k(g.input), k(g.cacheWrite), k(g.cacheRead), k(g.output)]);
    for (const t of Object.keys(total)) total[t] += g[t];
  }
  table.push(['TOTAL', '', '', total.runs, dur(total.ms), total.api, k(total.input), k(total.cacheWrite), k(total.cacheRead), k(total.output)]);
  const widths = header.map((_, i) => Math.max(...table.map((row) => String(row[i]).length)));
  const line = (row) => `| ${row.map((c, i) => String(c).padEnd(widths[i])).join(' | ')} |`;
  console.log([line(table[0]), `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`, ...table.slice(1).map(line)].join('\n'));
}

const [mode, arg] = process.argv.slice(2);
if (mode === 'report') {
  report(arg);
} else {
  try {
    await record();
  } catch (err) {
    process.stderr.write(`add-metrics: ${err.message}\n`);
  }
  process.exit(0);
}
