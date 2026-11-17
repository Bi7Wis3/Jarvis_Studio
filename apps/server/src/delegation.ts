// How many part builders are at work: a subagent starts with an Agent tool call in Jarvis's own messages, its own
// messages carry that call's id as parent_tool_use_id, and it is done when the call's result comes back.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** The names Claude Code gives the tool that starts a subagent (Task is the older one). */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

export const isAgentTool = (name: unknown): boolean => typeof name === 'string' && AGENT_TOOLS.has(name);

/** The status line while builders work: "working with 3 part builders". */
export const buildersText = (n: number): string => `working with ${n} part builder${n === 1 ? '' : 's'}`;

type Block = { type?: string; id?: string; name?: string; tool_use_id?: string };

export class Delegation {
    private running = new Set<string>();

    get count(): number {
        return this.running.size;
    }

    /** Takes one session message; returns the new number of builders at work when it changed, else null. */
    see(message: SDKMessage): number | null {
        const before = this.running.size;
        const m = message as { type: string; parent_tool_use_id?: string | null; event?: { type?: string; content_block?: Block };
            message?: { content?: unknown } };
        if (m.type === 'result') {
            this.running.clear();
        } else if (m.parent_tool_use_id) {
            // A subagent's own message: its call is running, whether or not its start was seen.
            this.running.add(m.parent_tool_use_id);
        } else if (m.type === 'stream_event' && m.event?.type === 'content_block_start' && m.event.content_block?.type === 'tool_use'
            && isAgentTool(m.event.content_block.name) && m.event.content_block.id) {
            this.running.add(m.event.content_block.id);
        } else if ((m.type === 'assistant' || m.type === 'user') && Array.isArray(m.message?.content)) {
            for (const block of m.message.content as Block[]) {
                if (m.type === 'assistant' && block.type === 'tool_use' && isAgentTool(block.name) && block.id) {
                    this.running.add(block.id);
                } else if (m.type === 'user' && block.type === 'tool_result' && block.tool_use_id) {
                    this.running.delete(block.tool_use_id);
                }
            }
        }
        return this.running.size === before ? null : this.running.size;
    }
}
