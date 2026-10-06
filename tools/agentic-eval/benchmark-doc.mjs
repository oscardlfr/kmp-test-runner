#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/benchmark-doc.mjs -- deterministic generator behind docs/agentic-benchmark.md.
// From one campaign's committed campaign-summary.json + cost-estimate.json it writes
//   - tools/runs/evidence<n>-agentic-benchmark-<date>/cost-breakdown.svg (bars as long as the median session cost, split by component), and
//   - the generated blocks of docs/agentic-benchmark.md for that evidence:
//       <!-- agentic-benchmark-doc:e<n>-cost-components:start (...) --> ... :end -->
//       <!-- agentic-benchmark-doc:e<n>-sessions:start (...) -->        ... :end -->
//   An evidence whose section also states its task and its session counts from data (Evidence3) generates two more
//   blocks, e<n>-scenario (the module and failing-method counts, read from the scenario's corpus files) and e<n>-run
//   (sessions run and counted, the count phrase, the record link), and the table that puts the campaigns side by side:
//       <!-- agentic-benchmark-doc:campaigns:start (...) -->                ... :end -->
//
// Usage:
//   node tools/agentic-eval/benchmark-doc.mjs [--write] --evidence=<n> --date=<yyyy-mm-dd>
// Without --write it runs in check mode: it regenerates, compares with the committed files (line
// endings ignored, so a Windows autocrlf checkout checks the same as a Linux one) and exits 1 on any
// difference. Fails closed on an invalid summary, a summary that does not pair with its cost
// estimate, a cost estimate that is not schema 2, or missing block markers.
//
// Everything is reused from readme-evidence.mjs (validators, pricing helpers, palettes, the
// composition-row renderer) and evidence2-tables.mjs (the per-session midpoint); nothing about a
// price or a token mapping is re-derived here.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadSummary, loadCostEstimate, validatePairing, disjointTokens, medianOf,
  countPhrase, fmtToolCallsMedian, loadScenarioFacts, loadCampaignRegistry,
  textItem, wrapWords, escapeXml, renderCompositionRow, runtimeModelLabel, toolOutputMeasured,
  TOKEN_COMPONENT_TYPES, TOKEN_COMPONENT_LABEL, TOKEN_COMPONENT_COLORS,
  RUNTIME_ORDER, ARM_ORDER, GRID_W, PAD, ROW_GAP, COLUMN_W, COLUMN_GAP,
  COLOR_TEXT, COLOR_SECONDARY, COLOR_WITH, COLOR_WITHOUT, COLOR_CARD_FILL, COLOR_CARD_STROKE, FONT_STACK,
} from './readme-evidence.mjs';
import { costEstimateCellEntry, costEstimateCellMidpoint } from './evidence2-tables.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DOC_PATH = join(REPO_ROOT, 'docs', 'agentic-benchmark.md');

// Segment order in the figure and column order in the cost table.
const COST_COMPONENTS = ['cache_write', 'cache_read', 'output', 'uncached_input'];
const AGENT_LABEL = { 'claude-code': 'Claude Code', 'codex-cli': 'Codex CLI' };
const ARM_LABEL = { product: 'with kmp-test', free: 'without' };
const NUMBER_WORD = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

const LEGEND_DESCENT = 0.25; // the part of a text line's font size that hangs below its baseline, for the room under the last legend line
const FIGURE_TITLE = 'Where a session\'s API cost goes';
const FIGURE_SUBTITLE = 'Bar length is the median session cost, on one scale for both agents; the colors split it by each group\'s share of its total cost (percentages below). Blue: with kmp-test; orange: without.';

// ---------------------------------------------------------------------------
// Cost components -- the same midpoint convention as costMetric / costEstimateCellMidpoint: the
// cache write is priced at the mean of the 5-minute and 1-hour rates, and uncached input at the mean
// of the plain input rate and (when a provider's usage events cannot tell a cache write from a plain
// input token) the dearer of the two cache-write rates.

/** One session's cost, in USD, split into the four components. They sum to the session midpoint. */
export function sessionCostComponents(entry, tokens) {
  const price = entry.per_million_tokens;
  const highInputPrice = entry.uncached_input_may_be_cache_writes === true
    ? Math.max(price.cache_write_5m, price.cache_write_1h)
    : price.input;
  return {
    cache_write: (tokens.cache_creation * (price.cache_write_5m + price.cache_write_1h)) / 2 / 1e6,
    cache_read: (tokens.cache_read * price.cache_read) / 1e6,
    output: (tokens.output * price.output) / 1e6,
    uncached_input: (tokens.input * (price.input + highInputPrice)) / 2 / 1e6,
  };
}

const sum = (values) => values.reduce((a, b) => a + b, 0);

/**
 * One entry per (runtime, arm) of the cost estimate: its sessions' components and totals, the
 * pooled share of each component (group sum / group total) and the component and total medians.
 */
export function costGroups(costEstimate) {
  if (costEstimate.schema !== 2) throw new Error('benchmark-doc needs a schema 2 cost estimate');
  const groups = [];
  for (const runtimeId of RUNTIME_ORDER) {
    const entry = costEstimate.runtimes && costEstimate.runtimes[runtimeId];
    if (!entry) throw new Error(`cost-estimate.runtimes.${runtimeId} is missing`);
    for (const arm of ARM_ORDER) {
      const cells = entry.cells.filter((c) => c.arm === arm);
      if (cells.length === 0) throw new Error(`cost-estimate.runtimes.${runtimeId} has no ${arm} cells`);
      const sessions = cells.map((c) => {
        const components = sessionCostComponents(entry, c.tokens);
        return { order_index: c.order_index, components, total: sum(COST_COMPONENTS.map((k) => components[k])) };
      });
      const total = sum(sessions.map((s) => s.total));
      const pooledShare = {};
      const medianComponent = {};
      for (const k of COST_COMPONENTS) {
        pooledShare[k] = sum(sessions.map((s) => s.components[k])) / total;
        medianComponent[k] = medianOf(sessions.map((s) => s.components[k]));
      }
      groups.push({ runtimeId, arm, sessions, pooledShare, medianComponent, medianTotal: medianOf(sessions.map((s) => s.total)) });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Figure: cost-breakdown.svg -- the metrics grid's frame, lanes and legend (renderCompositionRow). A bar is as long as its group's
// median session cost, on one dollar scale for the whole figure, and its colored segments split that length by the group's pooled share
// of each cost component; the legend prints the shares and the median is printed at the end of the bar.

const fmtUsd3 = (v) => `$${v.toFixed(3)}`;
function fmtShare(v) {
  if (v > 0 && v < 0.005) return '<1%';
  return `${Math.round(v * 100)}%`;
}

export function computeCostBreakdownLayout(summary, costEstimate) {
  const groups = costGroups(costEstimate);
  const items = [];
  const titleFS = 20;
  const titleY = PAD + titleFS;
  items.push(textItem('gridTitle', null, PAD, titleY, titleFS, 600, COLOR_TEXT, FIGURE_TITLE));
  const subtitleFS = 13;
  let subtitleY = titleY + ROW_GAP + subtitleFS;
  const subtitleLines = wrapWords(FIGURE_SUBTITLE, subtitleFS, GRID_W - 2 * PAD);
  subtitleLines.forEach((line, i) => {
    if (i > 0) subtitleY += subtitleFS + 4;
    items.push(textItem('gridSubtitle', null, PAD, subtitleY, subtitleFS, 400, COLOR_SECONDARY, line));
  });
  const headerBottom = subtitleY + ROW_GAP + 8;

  // One dollar scale for the whole figure: a bar is as long as its group's median session cost, and the group with the largest median fills
  // the lane, so any two bars can be compared. A segment is the group's pooled share of that cost in dollars (share x median), so it is not
  // the component's own median (the table's column); the legend keeps printing the share (`display`).
  const compMax = Math.max(...groups.map((g) => g.medianTotal), 1e-9);
  // The renderer prints fmtValue(total) at the end of each bar and fmtValue(the legend value) in the legend. The printed total is the median
  // session cost, already formatted, and the legend value is a share, so the one formatter passes a string through and formats a number as a share.
  const fmtValue = (v) => (typeof v === 'string' ? v : fmtShare(v));
  const composition = (group) => ({
    segments: COST_COMPONENTS.filter((k) => group.pooledShare[k] > 0)
      .map((k) => ({ type: k, value: group.pooledShare[k] * group.medianTotal, display: group.pooledShare[k] })),
    stat: 'median',
    total: fmtUsd3(group.medianTotal),
    totalIsComplete: true,
  });

  const bottoms = [];
  RUNTIME_ORDER.forEach((runtimeId, i) => {
    const colX = i === 0 ? PAD : PAD + COLUMN_W + COLUMN_GAP;
    const withGroup = groups.find((g) => g.runtimeId === runtimeId && g.arm === 'product');
    const withoutGroup = groups.find((g) => g.runtimeId === runtimeId && g.arm === 'free');
    const label = runtimeModelLabel(summary, runtimeId);
    const rendered = renderCompositionRow(
      colX, headerBottom, label, label, composition(withGroup), composition(withoutGroup), compMax,
      COST_COMPONENTS, TOKEN_COMPONENT_COLORS, TOKEN_COMPONENT_LABEL, fmtValue, undefined, true,
    );
    items.push(...rendered.items);
    bottoms.push(headerBottom + rendered.rowHeight);
  });
  // The card ends one PAD below the last legend line (its baseline plus the glyph descent), so the room under the legend equals the room at
  // the sides; the shared renderer's trailing row gap is for a row that another row follows, and this figure has one row.
  const legendLines = items.filter((item) => item.role === 'gridLegendLine');
  const lastLegend = legendLines.length > 0 ? legendLines.reduce((a, b) => (b.y > a.y ? b : a)) : null;
  const height = lastLegend ? lastLegend.y + lastLegend.fontSize * LEGEND_DESCENT + PAD : Math.max(...bottoms) + PAD;
  return { width: GRID_W, height: Math.round(height), items };
}

export function renderCostBreakdownSvg(summary, costEstimate) {
  const layout = computeCostBreakdownLayout(summary, costEstimate);
  const parts = [];
  for (const item of layout.items) {
    if (item.kind === 'text') {
      const anchorAttr = item.anchor !== 'start' ? ` text-anchor="${item.anchor}"` : '';
      parts.push(`<text x="${item.x.toFixed(1)}" y="${item.y.toFixed(1)}" font-size="${item.fontSize}" font-weight="${item.fontWeight}" fill="${item.fill}"${anchorAttr}>${escapeXml(item.text)}</text>`);
    } else if (item.kind === 'bar') {
      parts.push(`<rect x="${item.x.toFixed(1)}" y="${item.y.toFixed(1)}" width="${item.w.toFixed(1)}" height="${item.h.toFixed(1)}" rx="${item.rx}" fill="${item.fill}"/>`);
    } else if (item.kind === 'legendSwatch') {
      parts.push(`<rect x="${item.x.toFixed(1)}" y="${item.y.toFixed(1)}" width="${item.w}" height="${item.h}" fill="${item.fill}"/>`);
    }
  }
  const componentLegend = COST_COMPONENTS.map((k) => `${TOKEN_COMPONENT_LABEL[k]} (${TOKEN_COMPONENT_COLORS[k]})`).join(', ');
  const desc = `Each bar is as long as its group's median session cost, on one scale for the whole figure, and its colored segments split that cost by each component's share. Color legend. With kmp-test (${COLOR_WITH}), without (${COLOR_WITHOUT}). Cost component: ${componentLegend}.`;
  return `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" xmlns="http://www.w3.org/2000/svg" role="img" font-family="${FONT_STACK}">
  <title>${escapeXml(FIGURE_TITLE)}</title>
  <desc>${escapeXml(desc)}</desc>
  <rect x="1" y="1" width="${layout.width - 2}" height="${layout.height - 2}" rx="12" fill="${COLOR_CARD_FILL}" stroke="${COLOR_CARD_STROKE}" stroke-width="1"/>
  ${parts.join('\n  ')}
</svg>
`;
}

// ---------------------------------------------------------------------------
// Generated tables

const fmtYesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : '—');
const fmtFixed = (v, digits) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—');
const fmtThousands = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US') : '—');

export function buildCostComponentsBlock(costEstimate) {
  const groups = costGroups(costEstimate);
  const lines = [
    'Median cost per session by component (USD, estimated at list prices)',
    '',
    `| Agent and arm | ${COST_COMPONENTS.map((k) => TOKEN_COMPONENT_LABEL[k]).join(' | ')} | median session total | sessions |`,
    `|---|${COST_COMPONENTS.map(() => '---:|').join('')}---:|---:|`,
  ];
  for (const g of groups) {
    const cells = COST_COMPONENTS.map((k) => (g.sessions.every((s) => s.components[k] === 0) ? '—' : g.medianComponent[k].toFixed(3)));
    lines.push(`| ${AGENT_LABEL[g.runtimeId]} ${ARM_LABEL[g.arm]} | ${cells.join(' | ')} | ${g.medianTotal.toFixed(3)} | ${g.sessions.length} |`);
  }
  lines.push('', 'Component medians are taken separately, so they need not add up to the median total.');
  return lines.join('\n');
}

// Token columns: one per disjoint type, in TOKEN_COMPONENT_TYPES order (first appearance across
// the runtimes), so each agent's own types fall under the same heading.
function tokenColumnTypes() {
  const types = [];
  for (const runtimeId of RUNTIME_ORDER) for (const t of TOKEN_COMPONENT_TYPES[runtimeId]) if (!types.includes(t)) types.push(t);
  return types;
}

export function buildSessionsBlock(summary, costEstimate) {
  const tokenTypes = tokenColumnTypes();
  const header = [
    'Agent', 'Arm', 'Round', 'Key facts', 'Full answer', 'Wall-clock (min)', 'Tool calls', 'Shell kmp-test/Gradle/other', 'Turns',
    ...tokenTypes.map((t) => TOKEN_COMPONENT_LABEL[t]), 'Tool output (KB)', 'Est. cost (USD)',
  ];
  const align = header.map((_, i) => (i < 2 ? '---' : i === 3 || i === 4 ? '---' : '---:'));
  const lines = [`| ${header.join(' | ')} |`, `|${align.join('|')}|`];
  // One row per counted session (accepted or negative-D3, the cells every aggregate and the cost
  // estimate are built from). A session that was rejected and not replaced has no metrics to show and no
  // cost cell, so it gets no row rather than a row of empty values.
  const ordered = summary.cells.filter((c) => c.status !== 'missing')
    .sort((a, b) => RUNTIME_ORDER.indexOf(a.runtime_id) - RUNTIME_ORDER.indexOf(b.runtime_id) || a.round_index - b.round_index);
  for (const cell of ordered) {
    const tokens = cell.tokens ? disjointTokens(cell.tokens, cell.runtime_id) : {};
    const kinds = cell.command_kind_counts;
    const entry = costEstimateCellEntry(costEstimate, cell.runtime_id, cell.arm, cell.round_index);
    const cost = entry ? costEstimateCellMidpoint(costEstimate, cell.runtime_id, entry) : null;
    const toolOutput = toolOutputMeasured(summary, cell.runtime_id) ? fmtFixed(cell.output_bytes / 1000, 1) : '—';
    const row = [
      AGENT_LABEL[cell.runtime_id], ARM_LABEL[cell.arm], String(cell.round_index),
      fmtYesNo(cell.key_facts_match), fmtYesNo(cell.full_answer_match),
      fmtFixed(cell.duration_ms / 60000, 1), fmtThousands(cell.tool_calls_total),
      kinds ? `${kinds.kmp_test}/${kinds.gradle}/${kinds.other}` : '—',
      fmtThousands(cell.num_turns),
      ...tokenTypes.map((t) => fmtThousands(tokens[t])),
      toolOutput, fmtFixed(cost, 3),
    ];
    lines.push(`| ${row.join(' | ')} |`);
  }
  const note = missingSessionsNote(summary);
  if (note) lines.push('', note);
  return lines.join('\n');
}

// What the summary's reason code for a session without evidence means, for the two codes the closure produces for a
// session that is not counted; any other code is shown as it is, with no gloss.
const MISSING_REASON_GLOSS = Object.freeze({
  rejected_not_reclassifiable: 'the harness rejected the session',
  cell_directory_absent: 'no session evidence was recorded',
});

/** The sentence under the sessions table naming every session that is missing data and so has no row, or null when none
 * is. The campaign tables count counted sessions only; this keeps "every session" honest. */
export function missingSessionsNote(summary) {
  const missing = summary.cells.filter((c) => c.status === 'missing')
    .sort((a, b) => RUNTIME_ORDER.indexOf(a.runtime_id) - RUNTIME_ORDER.indexOf(b.runtime_id) || ARM_ORDER.indexOf(a.arm) - ARM_ORDER.indexOf(b.arm) || a.round_index - b.round_index);
  if (missing.length === 0) return null;
  const items = missing.map((c) => {
    const gloss = MISSING_REASON_GLOSS[c.reason];
    return `${AGENT_LABEL[c.runtime_id]} ${ARM_LABEL[c.arm]}, round ${c.round_index} (\`${c.reason}\`${gloss ? `: ${gloss}` : ''})`;
  });
  const lead = NUMBER_WORD[missing.length] ?? String(missing.length);
  return `${lead} ${missing.length === 1 ? 'session is' : 'sessions are'} not in the table because ${missing.length === 1 ? 'it is' : 'they are'} missing data: ${items.join('; ')}. The record's controls audit has the details.`;
}

// ---------------------------------------------------------------------------
// An evidence section's task and session paragraphs, and the table of both campaigns. Every number comes from the
// committed summary, the scenario's corpus files or the run directory's name.

/** The scenario paragraph is based on the scenario family and facts from its corpus files. The legacy
 * multi-module-tests wording is retained for the published Evidence3 document. */
export function buildScenarioBlock(scenarioFacts) {
  const { family = 'multi-module-tests', moduleCount } = scenarioFacts;
  if (!Number.isInteger(moduleCount) || moduleCount < 1) throw new Error('scenario publication: moduleCount must be a positive integer');
  switch (family) {
    case 'multi-module-tests':
      if (!Number.isInteger(scenarioFacts.failedCount) || scenarioFacts.failedCount < 0) throw new Error('scenario publication: failedCount must be a nonnegative integer');
      return `**Scenario:** in NowInAndroid, a small production-code change breaks tests in several modules. The agent runs the unit tests of every module except those whose Robolectric tests need network access, then reports which modules and test classes fail and how many tests. ${moduleCount} modules are in scope, with ${scenarioFacts.failedCount} failing test methods.`;
    case 'multi-module-coverage':
      return `**Scenario:** in NowInAndroid, the agent runs unit tests and measures LINE coverage separately for ${moduleCount} in-scope modules. It reports which modules fall below the ${scenarioFacts.thresholdPercent}% threshold and which have no coverage data.`;
    case 'changed-dependents':
      return `**Scenario:** in NowInAndroid, a committed production-code change affects a module whose own tests pass. The agent compares against the specified base, includes dependent modules, runs the selected unit tests and reports the selected modules and failing tests. ${moduleCount} modules are in scope.`;
    case 'compile-failure':
      return `**Scenario:** in NowInAndroid, a small production-code change breaks compilation. The agent runs the in-scope unit tests, identifies the failing compile task and diagnostic, and reports which dependents could not run. ${moduleCount} modules are in scope.`;
    default:
      throw new Error(`scenario publication: unsupported family ${family}`);
  }
}

/** Public, aggregate facts only. Do not copy expected module paths or diagnostics into the overview prose. */
export function loadScenarioPublicationFacts(scenarioId, corpusDir = join(REPO_ROOT, 'tools', 'agentic-eval', 'corpus')) {
  const scenario = JSON.parse(readFileSync(join(corpusDir, 'scenarios', `${scenarioId}.json`), 'utf8'));
  const expected = JSON.parse(readFileSync(join(corpusDir, 'expected', `${scenarioId}.json`), 'utf8'));
  if (scenario.id !== scenarioId || expected.id !== scenarioId) throw new Error(`scenario ${scenarioId}: corpus ids do not match`);
  if (scenario.family === 'multi-module-tests') return { family: scenario.family, ...loadScenarioFacts(scenarioId, corpusDir) };
  const tasks = scenario.policy?.allowed_gradle_tasks;
  const modules = new Set(Array.isArray(tasks) ? tasks.filter((task) => typeof task === 'string' && task.endsWith(':tasks')).map((task) => task.slice(0, -':tasks'.length)) : []);
  if (modules.size === 0) throw new Error(`scenario ${scenarioId}: allowed_gradle_tasks names no module (no "<module>:tasks" entry)`);
  const facts = { family: scenario.family, moduleCount: modules.size };
  if (scenario.family === 'multi-module-coverage') {
    const threshold = expected.expected?.threshold_percent;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      throw new Error(`scenario ${scenarioId}: expected.threshold_percent is not a valid percentage`);
    }
    facts.thresholdPercent = threshold;
  } else if (!['changed-dependents', 'compile-failure'].includes(scenario.family)) {
    throw new Error(`scenario ${scenarioId}: unsupported publication family ${scenario.family}`);
  }
  return facts;
}

function resolvedModel(summary, runtimeId) {
  const entry = summary.provenance?.model_resolved?.[runtimeId];
  const model = entry && Array.isArray(entry.values) && entry.values.length === 1 ? entry.values[0] : null;
  if (typeof model !== 'string' || model.length === 0) throw new Error(`campaign-summary.json provenance.model_resolved.${runtimeId} is not a single model`);
  return model;
}

// What an evidence's own record says about how its campaign came to be, keyed by evidence number; the preregistration and the record
// README of the run directory carry the same facts (a test reads both). Evidence3 is the campaign's second attempt: the first failed
// on infrastructure and is not analyzed (amendment A4). Its two sessions missing data are one rejected by the harness and one with no
// evidence at all, which the record explains as a failed call into the guest VM (amendment A5 treats such a loss like a rejection):
// `missingReasons` are the summary's reason codes for them, and the sentence is refused for a summary that differs.
const CAMPAIGN_HISTORY = Object.freeze({
  3: Object.freeze({
    attempt: 'This is the campaign\'s second attempt; the first failed on infrastructure and is not analyzed (preregistration amendment A4).',
    missingReasons: Object.freeze(['cell_directory_absent', 'rejected_not_reclassifiable']),
    missing: 'Two sessions are missing data and are not counted: one was rejected by the harness, one was lost to a failed call into the guest VM (amendment A5 treats such a loss like a rejection); none of them was re-run or replaced.',
  }),
});

// Sessions that are declared but not counted, for an evidence that has no history of its own: they are missing data, not replaced.
function notCountedSentence(count) {
  const lead = NUMBER_WORD[count] ?? String(count);
  return count === 1 ? `${lead} session is missing data and is not counted; it was not replaced.` : `${lead} sessions are missing data and are not counted; none of them was replaced.`;
}

/** The sessions paragraph: sessions run (the declared total) and counted, the per-agent-and-arm phrase (countPhrase),
 * the evidence's own history where its record has one, and the link to the record. `date` is the run directory's date. */
export function buildRunBlock({ evidenceN, date, summary }) {
  const groups = summary.by_runtime_arm;
  const run = sum(groups.map((g) => g.declared));
  const counted = sum(groups.map((g) => (typeof g.counted === 'number' ? g.counted : g.declared)));
  const own = CAMPAIGN_HISTORY[evidenceN];
  const missingReasons = summary.cells.filter((c) => c.status === 'missing').map((c) => c.reason).sort();
  if (own && JSON.stringify(missingReasons) !== JSON.stringify(own.missingReasons)) {
    throw new Error(`Evidence${evidenceN}: the history sentence describes sessions missing for ${own.missingReasons.join(' and ')}, but the summary's are ${missingReasons.join(', ') || 'none'}`);
  }
  const history = own ? [own.attempt, own.missing] : (run > counted ? [notCountedSentence(run - counted)] : []);
  return `**Sessions:** ${run} run, ${counted} counted; per agent and arm: ${countPhrase(summary)}. Claude Code (${resolvedModel(summary, 'claude-code')}) and Codex CLI (${resolvedModel(summary, 'codex-cli')}), in a counterbalanced order.${history.map((s) => ` ${s}`).join('')} Record: [Evidence${evidenceN}](../tools/runs/evidence${evidenceN}-agentic-benchmark-${date}/README.md).`;
}

// One row per campaign x agent x arm, each cell a median over the group's counted sessions.
const CAMPAIGNS_CAPTION = 'Median per session, by campaign (each campaign compares its own arms; the tasks differ)';
const CAMPAIGNS_HEADER = ['Campaign', 'Agent', 'Arm', 'Tool calls', 'Tool output (KB)', 'Total tokens', 'Est. cost (USD)', 'Wall-clock (min)', 'Key facts matched'];

function countedSessions(summary, runtimeId, arm) {
  return summary.cells.filter((c) => c.runtime_id === runtimeId && c.arm === arm && c.status !== 'missing');
}

/** The campaigns table. `campaigns`: [{ evidenceN, summary, costEstimate }] in the order to show. Tool output is a
 * dash where the campaign did not measure it for that agent (Codex CLI in Evidence2, erratum E6); where Codex CLI's
 * is measured, a footnote says it is the output of its commands as logged. */
export function buildCampaignsBlock(campaigns) {
  const lines = [CAMPAIGNS_CAPTION, '', `| ${CAMPAIGNS_HEADER.join(' | ')} |`, `|---|---|---|---:|---:|---:|---:|---:|---:|`];
  const notMeasured = [];
  let codexMeasured = false;
  for (const { evidenceN, summary, costEstimate } of campaigns) {
    for (const runtimeId of RUNTIME_ORDER) {
      const measured = toolOutputMeasured(summary, runtimeId);
      if (!measured) notMeasured.push(`Evidence${evidenceN}: tool output was not measured for ${AGENT_LABEL[runtimeId]}, shown as —.`);
      else if (runtimeId === 'codex-cli') codexMeasured = true;
      for (const arm of ARM_ORDER) {
        const group = summary.by_runtime_arm.find((g) => g.runtime_id === runtimeId && g.arm === arm);
        const sessions = countedSessions(summary, runtimeId, arm);
        if (!group || sessions.length === 0) throw new Error(`Evidence${evidenceN}: no counted sessions for ${runtimeId} ${arm}`);
        const toolCalls = medianOf(sessions.map((c) => c.tool_calls_total));
        const toolOutputKb = measured ? medianOf(sessions.map((c) => c.output_bytes)) / 1000 : null;
        const totalTokens = medianOf(sessions.map((c) => sum(Object.values(disjointTokens(c.tokens, runtimeId)))));
        const costs = sessions.map((c) => {
          const entry = costEstimateCellEntry(costEstimate, c.runtime_id, c.arm, c.round_index);
          if (!entry) throw new Error(`Evidence${evidenceN}: no cost-estimate cell for ${c.cell_key}`);
          return costEstimateCellMidpoint(costEstimate, c.runtime_id, entry);
        });
        const row = [
          `Evidence${evidenceN}`, AGENT_LABEL[runtimeId], ARM_LABEL[arm],
          fmtToolCallsMedian(toolCalls), fmtFixed(toolOutputKb, 1), fmtThousands(Math.round(totalTokens)),
          fmtFixed(medianOf(costs), 3), fmtFixed(medianOf(sessions.map((c) => c.duration_ms)) / 60000, 1),
          `${group.key_facts_match.matched}/${group.key_facts_match.of}`,
        ];
        lines.push(`| ${row.join(' | ')} |`);
      }
    }
  }
  const taskCount = NUMBER_WORD[campaigns.length]?.toLowerCase() ?? String(campaigns.length);
  const notes = [`Key facts matched: counted sessions whose final answer matched the key facts of that campaign's task, out of the counted sessions; the key facts differ between the ${taskCount} tasks.`];
  if (codexMeasured) notes.push('Tool output is the tool results returned to the model for Claude Code and, for Codex CLI, command output as logged; Codex may shorten what the model reads.');
  notes.push(...notMeasured);
  if (notes.length > 0) lines.push('', ...notes.map((n) => `- ${n}`));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// docs/agentic-benchmark.md blocks

export function docBlockMarkers(blockId) {
  return {
    start: `<!-- agentic-benchmark-doc:${blockId}:start (generated by tools/agentic-eval/benchmark-doc.mjs; do not edit) -->`,
    end: `<!-- agentic-benchmark-doc:${blockId}:end -->`,
  };
}

/** The generated blocks of one evidence, keyed by block id. `context` (optional) adds the blocks of an evidence whose
 * section generates its task and session paragraphs and the campaigns table: { date, scenarioFacts, campaigns }. */
export function docBlocks(evidenceN, summary, costEstimate, context = null) {
  const blocks = {
    [`e${evidenceN}-cost-components`]: buildCostComponentsBlock(costEstimate),
    [`e${evidenceN}-sessions`]: buildSessionsBlock(summary, costEstimate),
  };
  if (context) {
    blocks[`e${evidenceN}-scenario`] = buildScenarioBlock(context.scenarioFacts);
    blocks[`e${evidenceN}-run`] = buildRunBlock({ evidenceN, date: context.date, summary });
    blocks.campaigns = buildCampaignsBlock(context.campaigns);
  }
  return blocks;
}

/** The text between a block's markers, or null when the markers are absent or out of order. */
export function readDocBlock(doc, blockId) {
  const { start, end } = docBlockMarkers(blockId);
  const s = doc.indexOf(start);
  const e = doc.indexOf(end);
  if (s === -1 || e === -1 || e < s) return null;
  return doc.slice(s + start.length, e);
}

/** The doc with every given block's content replaced; throws when a block's markers are missing. */
export function fillDocBlocks(doc, blocks) {
  let out = doc;
  for (const [blockId, content] of Object.entries(blocks)) {
    const { start, end } = docBlockMarkers(blockId);
    const s = out.indexOf(start);
    const e = out.indexOf(end);
    if (s === -1 || e === -1 || e < s) throw new Error(`docs/agentic-benchmark.md is missing the ${blockId} block markers`);
    out = `${out.slice(0, s + start.length)}\n${content}\n${out.slice(e)}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI

// The earlier campaigns the both-campaigns table shows next to the current one: evidence number -> the date of its run
// directory. The evidences whose section generates its task and session paragraphs and that table.
/** The extra input of an evidence that generates its paragraphs and the campaigns table; null for Evidence2.
 * The validated overview registry supplies every published campaign in display order. The shared table is
 * cumulative even when checking an earlier section after later campaigns are published. The current campaign
 * must already be registered, so a partial publication cannot silently omit it. */
export function docContext(evidenceN, date, summary, costEstimate, options = {}) {
  const n = Number(evidenceN);
  if (n < 3) return null;
  const registered = options.campaigns ?? loadCampaignRegistry();
  const currentDir = `evidence${n}-agentic-benchmark-${date}`;
  const current = registered.filter((campaign) => campaign.evidenceN === n);
  if (current.length !== 1 || current[0].dir !== currentDir) {
    throw new Error(`Evidence${n}: expected exactly one registry entry named ${currentDir}`);
  }
  const campaigns = registered
    .map((campaign) => campaign.evidenceN === n
      ? { evidenceN: n, summary, costEstimate }
      : { evidenceN: campaign.evidenceN, summary: campaign.summary, costEstimate: campaign.costEstimate });
  if (campaigns.some((campaign, i) => campaigns.findIndex((other) => other.evidenceN === campaign.evidenceN) !== i)) {
    throw new Error(`Evidence${n}: duplicate evidence numbers in campaign registry`);
  }
  return { date, scenarioFacts: loadScenarioPublicationFacts(summary.scenario_id, options.corpusDir), campaigns };
}

const lf = (text) => text.replace(/\r\n/g, '\n');

/** The generated files whose committed text differs from the generated one. Line endings are ignored: a checkout with core.autocrlf
 * (a Windows runner) holds CRLF on disk, and the generator writes LF. `doc` is the committed document, `filled` the document with the
 * blocks regenerated, `svg` the generated figure. */
export function staleOutputs({ svgPath, svg, docPath, doc, filled }) {
  const stale = [];
  if (!existsSync(svgPath) || lf(readFileSync(svgPath, 'utf8')) !== svg) stale.push(svgPath);
  if (lf(doc) !== lf(filled)) stale.push(docPath);
  return stale;
}

function main(argv) {
  const mode = argv.includes('--write') ? 'write' : 'check';
  const evidenceN = (argv.find((a) => a.startsWith('--evidence=')) || '').split('=')[1];
  const campaignDate = (argv.find((a) => a.startsWith('--date=')) || '').split('=')[1];
  if (!/^\d+$/.test(evidenceN || '') || !/^\d{4}-\d{2}-\d{2}$/.test(campaignDate || '')) {
    console.error('::error::usage: node tools/agentic-eval/benchmark-doc.mjs [--write] --evidence=<n> --date=<yyyy-mm-dd>');
    process.exit(1);
  }
  const runsDir = join(REPO_ROOT, 'tools', 'runs', `evidence${evidenceN}-agentic-benchmark-${campaignDate}`);
  const summaryPath = join(runsDir, 'campaign-summary.json');
  const costEstimatePath = join(runsDir, 'cost-estimate.json');
  for (const p of [summaryPath, costEstimatePath, DOC_PATH]) {
    if (!existsSync(p)) {
      console.error(`::error::${p} not found`);
      process.exit(1);
    }
  }

  let summary, costEstimate, svg, filled;
  const doc = readFileSync(DOC_PATH, 'utf8');
  try {
    summary = loadSummary(summaryPath);
    costEstimate = loadCostEstimate(costEstimatePath);
    const pairingErrors = validatePairing(summary, costEstimate);
    if (pairingErrors.length > 0) throw new Error(`campaign-summary.json / cost-estimate.json mismatch:\n  ${pairingErrors.join('\n  ')}`);
    svg = renderCostBreakdownSvg(summary, costEstimate);
    filled = fillDocBlocks(lf(doc), docBlocks(evidenceN, summary, costEstimate, docContext(evidenceN, campaignDate, summary, costEstimate)));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }

  const svgPath = join(runsDir, 'cost-breakdown.svg');
  if (mode === 'write') {
    writeFileSync(svgPath, svg);
    writeFileSync(DOC_PATH, filled);
    console.log(`Wrote ${svgPath}\nUpdated the evidence ${evidenceN} blocks of ${DOC_PATH}`);
    return;
  }

  const mismatches = staleOutputs({ svgPath, svg, docPath: DOC_PATH, doc, filled });
  if (mismatches.length > 0) {
    console.error(`::error::out of date, run with --write: ${mismatches.join(', ')}`);
    process.exit(1);
  }
  console.log(`Evidence ${evidenceN} cost breakdown and docs/agentic-benchmark.md blocks are up to date.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
