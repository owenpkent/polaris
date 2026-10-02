// MCP prompts. daily_review walks the agenda and inbox with the owner, one item at a time.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const DAILY_REVIEW_TEXT = [
  'Run my daily review.',
  '',
  '1. Read the polaris://agenda/today resource for what is due today, what is overdue, and the inbox count.',
  '2. Call list_inbox to get the full inbox list. Go through the items one at a time. For each item, summarize it in one line and state a recommendation, then offer it as a choice: A) accept as proposed, B) accept with changes (say exactly what you would change), or C) reject (say why). Wait for my answer before moving to the next item; do not call accept_inbox_item or reject_inbox_item until I answer.',
  '3. For every overdue task from step 1, name it and offer a choice: A) reschedule (propose a new due date), B) keep as is, or C) drop it. Wait for my answer.',
  '4. Propose at most three focus tasks for today, drawn from open tasks and anything just accepted from the inbox. State why each one matters today in one line.',
  '',
  'Do not create, update, accept, reject, or otherwise change anything without my explicit answer for that specific item. Prefer A/B/C style choices over open-ended questions.',
].join('\n');

export function registerPrompts(server: McpServer): void {
  server.registerPrompt('daily_review', {
    title: 'Daily review',
    description: "Walk today's agenda and inbox one item at a time, proposing accept/reject/reschedule choices, then suggest up to three focus tasks.",
  }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: DAILY_REVIEW_TEXT } }],
  }));
}
