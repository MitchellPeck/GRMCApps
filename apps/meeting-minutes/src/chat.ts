import Anthropic from "@anthropic-ai/sdk";
import { Pool } from "pg";
import { appendChat, loadChatHistory } from "./chatStore";
import { CHAT_TOOLS, ChatCard, runChatTool } from "./chatTools";

// The chat beside the minutes: Claude with the meeting's tools. One user
// message runs a short tool loop; every message is stored exactly as sent or
// returned and the history is only ever appended to, so thinking blocks replay
// unchanged on the next turn.

export const CHAT_MODEL = "claude-opus-5-5";
const MAX_CALLS = 12;

export const CHAT_SYSTEM = `You help a church secretary finish the minutes of a meeting. You work on one meeting, through tools that do exactly what the meeting page does: read the meeting, its transcripts and its minutes; fix misheard names; name speakers; change details, attendance, guests and agenda topics; edit the minutes line by line; and play parts of the recording.

How to work:
- Look before you change anything: get_meeting first if you don't know the topics or voices; get_report before editing the minutes, and use its line numbers.
- A misheard name or word anywhere: fix_words (it corrects transcripts, summaries, action items, speakers, guests and the minutes together). Use edit_report only for wording, shortening, adding or removing lines.
- Keep the minutes concise: they should come to 5-7 pages at most, about half to three-quarters of a page per topic. Summarize what was reported, decided and what happens next; never invent facts, names or figures.
- To show where something was said, find it with search_transcripts or get_transcript and call play_clip with the times from the transcript stamps.
- Removing a topic, regenerating the minutes and reprocessing the recording can't easily be undone: ask the person first in plain words, and only call the tool with confirmed: true after they have said yes in this conversation.
- Deleting the meeting, Settings and the people list are not yours to change; say they can do those on the page.

Reply briefly in plain sentences: what you did or found, with times as mm:ss. The page shows a card for each change with an Undo button, so you don't need to repeat counts the card shows.`;

export interface ChatModel {
  create(params: Anthropic.Beta.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.BetaMessage>;
}

// The real model: the meeting app's API key, refusal fallback on.
export function anthropicChatModel(apiKey: string): ChatModel {
  const client = new Anthropic({ apiKey });
  return { create: (params) => client.beta.messages.create(params) };
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text.trim()).filter(Boolean).join("\n\n");
}

export async function chatTurn(
  pool: Pool,
  meetingId: number,
  text: string,
  who: { email: string; name: string },
  model: ChatModel
): Promise<{ reply: string; cards: ChatCard[] }> {
  const history = (await loadChatHistory(pool, meetingId)).map((r) => ({ role: r.role, content: r.content }) as Anthropic.Beta.BetaMessageParam);
  const user: Anthropic.Beta.BetaMessageParam = { role: "user", content: [{ type: "text", text }] };
  history.push(user);
  await appendChat(pool, meetingId, "user", user.content as unknown[], [], who.email);

  const cards: ChatCard[] = [];
  const replies: string[] = [];
  // Close the turn with a stored assistant message, so the history always
  // ends with the assistant and every tool_use has its tool_result.
  const finish = async (reply: string) => {
    await appendChat(pool, meetingId, "assistant", [{ type: "text", text: reply }], [], "");
    return { reply, cards };
  };

  for (let call = 0; call < MAX_CALLS; call++) {
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await model.create({
        model: CHAT_MODEL,
        max_tokens: 16000,
        system: CHAT_SYSTEM,
        tools: CHAT_TOOLS as Anthropic.Beta.BetaToolUnion[],
        messages: history,
        output_config: { effort: "medium" },
        cache_control: { type: "ephemeral" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (e) {
      console.error(`[chat] meeting ${meetingId}: ${(e as Error).message}`);
      return finish("Sorry, I couldn’t finish that: the AI service didn’t respond. Please try again.");
    }

    if (res.stop_reason === "refusal") return finish("I can't help with that one.");
    const said = textOf(res.content);
    if (said) replies.push(said);
    const toolUses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    // A tool input cut off at max_tokens can parse as a partial object; never
    // run it.
    if (!toolUses.length || res.stop_reason === "max_tokens") {
      // Cards were stored with the tool results that made them.
      await appendChat(pool, meetingId, "assistant", res.content as unknown[], [], "");
      history.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
      if (toolUses.length) return finish("That answer was cut short. Could you ask again, a step at a time?");
      return { reply: replies.join("\n\n") || "Done.", cards };
    }

    await appendChat(pool, meetingId, "assistant", res.content as unknown[], [], "");
    history.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
    // Every tool_use in the response is answered in one user message.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    const turnCards: ChatCard[] = [];
    for (const tu of toolUses) {
      let out;
      try {
        out = await runChatTool(pool, meetingId, tu.name, tu.input, who);
      } catch (e) {
        console.error(`[chat] tool ${tu.name}: ${(e as Error).message}`);
        out = { content: `That didn't work: ${(e as Error).message}`, isError: true };
      }
      if (out.card) turnCards.push(out.card);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
    }
    cards.push(...turnCards);
    await appendChat(pool, meetingId, "user", results as unknown[], turnCards, "");
    history.push({ role: "user", content: results });
  }
  return finish("I stopped there: that was taking too many steps. Tell me what's left and I'll carry on.");
}

// The conversation as the page shows it: what people wrote, and what the chat
// said back (with its cards), one entry per user message. Tool calls and their
// results are not shown.
export async function chatDisplay(
  pool: Pool,
  meetingId: number
): Promise<Array<{ role: "user" | "assistant"; text: string; cards: ChatCard[]; created_at: string }>> {
  const out: Array<{ role: "user" | "assistant"; text: string; cards: ChatCard[]; created_at: string }> = [];
  for (const row of await loadChatHistory(pool, meetingId)) {
    const blocks = row.content as any[];
    if (row.role === "user" && blocks.some((b) => b.type === "text")) {
      out.push({ role: "user", text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"), cards: [], created_at: row.created_at });
      continue;
    }
    let last = out[out.length - 1];
    if (!last || last.role !== "assistant") {
      last = { role: "assistant", text: "", cards: [], created_at: row.created_at };
      out.push(last);
    }
    if (row.role === "assistant") {
      const t = blocks.filter((b) => b.type === "text").map((b) => String(b.text).trim()).filter(Boolean).join("\n\n");
      if (t) last.text = last.text ? `${last.text}\n\n${t}` : t;
    }
    last.cards.push(...(row.cards as ChatCard[]));
  }
  return out;
}
