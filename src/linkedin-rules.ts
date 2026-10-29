/**
 * Pure, dependency-free rule engine for the LinkedIn Comment Assistant.
 *
 * Deliberately free of any LinkedIn API, fetch, DOM, or chrome.* call, so it
 * can be unit-tested in plain Node (see /tmp tests during development) and so
 * no part of it can send anything to LinkedIn. It only matches text the user
 * pasted in themselves and renders a draft for the user to copy.
 */

import type { LinkedInAccountKind, LinkedInComment, LinkedInDraft, LinkedInRule, LinkedInTemplate } from "./types";

/** A linkedin.com URL (with or without www) — anything else is rejected. */
export function isLinkedInPostUrl(url: string): boolean {
  if (!url) return true; // postUrl is optional; an empty link is allowed
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "linkedin.com" || parsed.hostname === "www.linkedin.com");
  } catch {
    return false;
  }
}

function normalize(text: string): string {
  return text.toLowerCase();
}

/** Does this rule apply to this comment's account kind and text? */
export function ruleMatches(rule: LinkedInRule, comment: LinkedInComment): boolean {
  if (!rule.enabled) return false;
  if (rule.accountKind !== "both" && rule.accountKind !== comment.accountKind) return false;
  const keywords = rule.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (keywords.length === 0) return false; // empty keywords must never match
  const haystack = normalize(comment.text);
  return keywords.some((k) => haystack.includes(k));
}

/** Highest-priority matching rule wins; ties break by rule order (stable). */
export function findMatchingRule(rules: LinkedInRule[], comment: LinkedInComment): LinkedInRule | undefined {
  const matching = rules.filter((r) => ruleMatches(r, comment));
  if (matching.length === 0) return undefined;
  matching.sort((a, b) => b.priority - a.priority);
  return matching[0];
}

/** Replace {{author}} (commenter name) in a template body. */
export function renderTemplate(body: string, comment: LinkedInComment): string {
  return body.replace(/\{\{\s*author\s*\}\}/g, comment.authorName || "there");
}

export const LINKEDIN_DEFAULT_TEMPLATE_BODY =
  "Thank you for your comment, {{author}}! We appreciate you taking the time to share your thoughts.";

export interface LinkedInDraftOutcome {
  /** "ignored" when the winning rule's action is ignore; otherwise "drafted". */
  outcome: "ignored" | "drafted" | "no_rule";
  rule?: LinkedInRule;
  draft?: Omit<LinkedInDraft, "id" | "createdAt">;
  /** New status for the comment after this outcome. */
  newStatus: LinkedInComment["status"];
}

/**
 * Run the rules over one comment and produce either an ignore outcome, a
 * draft, or "no_rule". Never sends anything anywhere — the draft is returned
 * for the user to copy, edit, and send themselves on LinkedIn.
 */
export function generateLinkedInDraft(
  comment: LinkedInComment,
  rules: LinkedInRule[],
  templates: LinkedInTemplate[],
): LinkedInDraftOutcome {
  const rule = findMatchingRule(rules, comment);
  if (!rule) return { outcome: "no_rule", newStatus: comment.status };
  if (rule.action === "ignore") {
    return { outcome: "ignored", rule, newStatus: "ignored" };
  }
  const template = templates.find((t) => t.id === rule.templateId);
  const text = template ? renderTemplate(template.body, comment) : renderTemplate(LINKEDIN_DEFAULT_TEMPLATE_BODY, comment);
  const kind = rule.action === "private_message_draft" ? "private_message" : "public_reply";
  return {
    outcome: "drafted",
    rule,
    draft: { commentId: comment.id, kind, text, status: "draft", apiStatus: "not_sent" },
    newStatus: "drafted",
  };
}

/** Validate edited draft text; returns an error string or null. */
export function validateDraftText(text: string): string | null {
  if (!text.trim()) return "Draft text cannot be empty.";
  return null;
}

/**
 * Pure draft edit: returns the updated draft, or an error string.
 * Editing never changes `status` or `apiStatus` — in particular, editing a
 * draft the user already marked as sent manually does not unsend anything
 * (the extension never sent it) and does not reset that record.
 */
export function applyDraftEdit(
  draft: LinkedInDraft,
  newText: string,
): { draft: LinkedInDraft } | { error: string } {
  const error = validateDraftText(newText);
  if (error) return { error };
  return { draft: { ...draft, text: newText.trim() } };
}

/**
 * Pure manual-sent marking: records that the USER sent this text themselves
 * on LinkedIn. `apiStatus` deliberately stays "not_sent" — this is a local
 * record of the user's own action, not a claim that the extension sent it.
 */
export function markDraftSentManually(draft: LinkedInDraft): LinkedInDraft {
  return { ...draft, status: "sent_manually", apiStatus: "not_sent" };
}

/** Validate a rule before it is saved; returns an error string or null. */
export function validateLinkedInRule(rule: LinkedInRule): string | null {
  if (!rule.name.trim()) return "Rule name is required.";
  if (rule.keywords.filter((k) => k.trim()).length === 0) return "At least one keyword is required.";
  if (!Number.isFinite(rule.priority)) return "Priority must be a number.";
  return null;
}

/** Validate a manually entered comment; returns an error string or null. */
export function validateLinkedInComment(comment: { text: string; postUrl: string }): string | null {
  if (!comment.text.trim()) return "Comment text is required.";
  if (!isLinkedInPostUrl(comment.postUrl)) return "Post link must be a https://linkedin.com or https://www.linkedin.com URL, or left empty.";
  return null;
}

/** Default starter rules/templates, seeded only when no LinkedIn data exists yet. */
export function defaultLinkedInRules(): LinkedInRule[] {
  return [
    {
      id: "li-rule-thanks",
      name: "Thank-you replies",
      accountKind: "both",
      keywords: ["great", "thank", "helpful", "insightful", "congratulations"],
      action: "public_reply_draft",
      templateId: "li-tpl-thanks",
      enabled: true,
      priority: 10,
    },
    {
      id: "li-rule-pricing",
      name: "Pricing questions -> private message draft",
      accountKind: "both",
      keywords: ["price", "pricing", "cost", "quote"],
      action: "private_message_draft",
      templateId: "li-tpl-pricing",
      enabled: true,
      priority: 20,
    },
  ];
}

export function defaultLinkedInTemplates(): LinkedInTemplate[] {
  return [
    { id: "li-tpl-thanks", name: "Thank you", body: "Thank you so much, {{author}}! Glad this resonated with you." },
    {
      id: "li-tpl-pricing",
      name: "Pricing (private)",
      body: "Hi {{author}}, thanks for asking! I will send you the pricing details in a private message shortly.",
    },
  ];
}

export type { LinkedInAccountKind };
