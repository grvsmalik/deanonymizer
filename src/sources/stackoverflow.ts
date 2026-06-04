import type { Item, Profile } from "../types.js";
import { fetchAndExtractSite, normalizeUrl } from "./web.js";

/**
 * Stack Overflow ingestion via the Stack Exchange API v2.3. No auth required
 * for low-volume runs (~300/day per IP). Accepts the numeric user_id or any
 * SO profile URL — the leading digits are what the API keys off.
 *
 * Pulls answers, questions, and comments plus the public profile fields
 * (display name, location, website, about). The `withbody` filter returns
 * HTML bodies which we strip to plain text before handing to the analyzer.
 */

const BASE = "https://api.stackexchange.com/2.3";
const SITE = "stackoverflow";

interface SEResp<T> {
  items?: T[];
  has_more?: boolean;
}

interface SEUser {
  user_id: number;
  display_name: string;
  link: string;
  location?: string;
  website_url?: string;
  about_me?: string;
  creation_date: number;
}

interface SEAnswer {
  answer_id: number;
  creation_date: number;
  body?: string;
  link?: string;
}

interface SEQuestion {
  question_id: number;
  creation_date: number;
  title: string;
  body?: string;
  link: string;
  tags?: string[];
}

interface SEComment {
  comment_id: number;
  post_id: number;
  creation_date: number;
  body?: string;
  link?: string;
}

function parseUserId(input: string): number {
  const m = input.match(/(\d+)/);
  if (!m) {
    throw new Error(
      `Stack Overflow target must be a numeric user_id or a profile URL ` +
        `containing one; got "${input}".`,
    );
  }
  return Number.parseInt(m[1], 10);
}

function stripHtml(s: string): string {
  return s
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+\n/g, "\n")
    .trim();
}

async function seFetch<T>(
  path: string,
  params: Record<string, string>,
): Promise<SEResp<T>> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("site", SITE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { "User-Agent": "deanonymizer/0.1 (privacy self-audit)" },
  });
  if (!res.ok) {
    throw new Error(`Stack Exchange ${path} ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as SEResp<T>;
}

async function fetchPaged<T>(
  path: string,
  max: number,
  extra: Record<string, string> = {},
): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  while (out.length < max && page <= 10) {
    const resp = await seFetch<T>(path, {
      page: String(page),
      pagesize: "100",
      order: "desc",
      sort: "creation",
      filter: "withbody",
      ...extra,
    });
    const batch = resp.items ?? [];
    if (batch.length === 0) break;
    out.push(...batch);
    if (!resp.has_more) break;
    page += 1;
  }
  return out.slice(0, max);
}

export async function fetchStackOverflow(
  idOrSlug: string,
  max: number,
): Promise<Profile> {
  const userId = parseUserId(idOrSlug);

  // Default filter already exposes display_name, location, website_url, link,
  // and creation_date — that's enough identity signal. about_me would require
  // a custom Stack Apps filter id which we keep out of the codebase.
  const userResp = await seFetch<SEUser>(`/users/${userId}`, {});
  const user = userResp.items?.[0];
  if (!user) {
    throw new Error(`Stack Overflow user_id ${userId} not found.`);
  }

  const items: Item[] = [];

  const bioBits: string[] = [];
  if (user.display_name) bioBits.push(`Display name: ${user.display_name}`);
  if (user.location) bioBits.push(`Location: ${user.location}`);
  if (user.website_url) bioBits.push(`Website: ${user.website_url}`);
  if (user.about_me) bioBits.push(`About: ${stripHtml(user.about_me)}`);
  if (bioBits.length > 0) {
    items.push({
      platform: "stackoverflow",
      id: `${userId}-profile`,
      kind: "post",
      context: "profile",
      body: bioBits.join("\n"),
      createdUtc: user.creation_date,
      permalink: user.link,
    });
  }

  // Shallow follow of the profile's declared website (one hop).
  if (user.website_url) {
    const url = normalizeUrl(user.website_url);
    if (url) {
      const text = await fetchAndExtractSite(url);
      if (text && text.length > 80) {
        items.push({
          platform: "stackoverflow",
          id: `${userId}-website`,
          kind: "post",
          context: "external site + sub-pages (linked from stackoverflow profile)",
          body: text.slice(0, 24000),
          createdUtc: user.creation_date,
          permalink: url,
        });
      }
    }
  }

  const [answers, questions, comments] = await Promise.all([
    fetchPaged<SEAnswer>(`/users/${userId}/answers`, max),
    fetchPaged<SEQuestion>(`/users/${userId}/questions`, Math.ceil(max / 2)),
    fetchPaged<SEComment>(`/users/${userId}/comments`, max),
  ]);

  for (const a of answers) {
    if (!a.body) continue;
    items.push({
      platform: "stackoverflow",
      id: `a${a.answer_id}`,
      kind: "post",
      context: "answer",
      body: stripHtml(a.body),
      createdUtc: a.creation_date,
      permalink: a.link ?? `https://stackoverflow.com/a/${a.answer_id}`,
    });
  }

  for (const q of questions) {
    items.push({
      platform: "stackoverflow",
      id: `q${q.question_id}`,
      kind: "post",
      context: `question${q.tags?.length ? ` (${q.tags.join(", ")})` : ""}`,
      title: q.title,
      body: [q.title, q.body ? stripHtml(q.body) : ""].filter(Boolean).join("\n"),
      createdUtc: q.creation_date,
      permalink: q.link,
    });
  }

  for (const c of comments) {
    if (!c.body) continue;
    items.push({
      platform: "stackoverflow",
      id: `c${c.comment_id}`,
      kind: "comment",
      context: "comment",
      body: stripHtml(c.body),
      createdUtc: c.creation_date,
      permalink: c.link ?? `https://stackoverflow.com/q/${c.post_id}`,
    });
  }

  items.sort((a, b) => b.createdUtc - a.createdUtc);

  return {
    platform: "stackoverflow",
    username: user.display_name,
    profileUrl: user.link,
    items,
    firstUtc: items.length ? items[items.length - 1].createdUtc : undefined,
    lastUtc: items.length ? items[0].createdUtc : undefined,
  };
}
