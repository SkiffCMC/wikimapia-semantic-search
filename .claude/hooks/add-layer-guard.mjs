#!/usr/bin/env node
// PreToolUse guard for the ADD subagents: each layer may write only its own artifacts.
// Usage (from an agent's frontmatter hook): node .claude/hooks/add-layer-guard.mjs <agent-name>
// Exit 2 blocks the tool call and returns stderr to the agent.
import path from 'node:path';

// allow: the only prefixes the agent may write to. deny: everything else is allowed.
const RULES = {
  'add-analyst': { allow: ['docs/al6-requirements/'] },
  'add-contracts': { allow: ['contracts/'] },
  'add-designer': { allow: ['docs/al4-design/'] },
  'add-router': { allow: ['docs/al3-routing/'] },
  'add-test-writer': { allow: ['tests/'] },
  'add-coder': { deny: ['contracts/', 'docs/', 'tests/', '.claude/', '.agrules'] },
};

const agent = process.argv[2];
const rule = RULES[agent];
if (!rule) {
  process.stderr.write(`add-layer-guard: unknown agent "${agent}"\n`);
  process.exit(2);
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let filePath;
try {
  const input = JSON.parse(raw);
  filePath = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
} catch {
  process.stderr.write('add-layer-guard: could not parse hook input\n');
  process.exit(2);
}
if (!filePath) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const rel = path.relative(path.resolve(root), path.resolve(root, filePath)).replaceAll('\\', '/');
const key = rel.toLowerCase();
const outside = key.startsWith('../') || path.isAbsolute(rel);
const under = (prefixes) => prefixes.some((p) => key === p || key.startsWith(p));

const blocked = rule.allow ? outside || !under(rule.allow) : !outside && under(rule.deny);
if (!blocked) process.exit(0);

const scope = rule.allow
  ? `may write only under: ${rule.allow.join(', ')}`
  : `may not write under: ${rule.deny.join(', ')}`;
process.stderr.write(
  `ADD layer guard: ${agent} ${scope}. Blocked write to "${rel}". ` +
    'Do not work around this (including through Bash). If another layer\'s artifact is wrong, ' +
    'stop and report the conflict to the orchestrator in your final message.\n',
);
process.exit(2);
