// 记忆文件解析：frontmatter（name/description）+ 正文按 ## 分节 → 原子笔记候选
// 每个记忆文件 → 若干 NoteCandidate（一节一条），hash 用于幂等
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface MemFileMeta {
  path: string;
  hash: string; // sha256，幂等去重用
  name: string;
  description: string;
}

export interface NoteCandidate {
  title: string;
  content: string;
  sourceRef: string; // 源文件名（溯源）
  truncated: boolean; // 内容超长被截断（导入报告标注）
  category?: string; // frontmatter 声明（如 journal 固定 archive/journal，跳过 LLM 分类）
  kind?: string; // frontmatter 声明（journal 固定 experience，永不失效）
  validAt?: string; // frontmatter 声明（日志写作日期，时间窗过滤依赖）
}

export const MAX_NOTE_LENGTH = 300; // A-MEM 原子笔记上限（字符）

export function hashFile(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 4);
    if (end !== -1) {
      const fm = text.slice(4, end).trim();
      for (const line of fm.split('\n')) {
        const m = line.match(/^([\w-]+):\s*(.*)$/);
        if (m) meta[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
      }
      return { meta, body: text.slice(end + 4) };
    }
  }
  return { meta, body: text };
}

export function parseMemoryFile(filePath: string): { meta: MemFileMeta; candidates: NoteCandidate[] } {
  const text = readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(text);
  const name = meta['name'] ?? filePath.split('/').pop()!.replace(/\.md$/, '');
  const description = meta['description'] ?? '';
  // 文件级长度上限：frontmatter 可声明 maxlength（日志/随笔整篇一条时用，如 maxlength: 2000）
  const maxLength = meta['maxlength'] ? Number(meta['maxlength']) : MAX_NOTE_LENGTH;
  // frontmatter 声明的分类/类型/时间：journal 固定分类跳过 LLM；valid_at 供时间窗过滤
  const fixedCategory = meta['category'];
  const fixedKind = meta['kind'];
  const fixedValidAt = meta['valid_at'] || undefined;

  const candidates: NoteCandidate[] = [];

  // 文件级候选：description 若存在，作为文件概要笔记（描述整个文件）
  if (description) {
    const [content, truncated] = truncate(description, maxLength);
    candidates.push({ title: name, content, sourceRef: name, truncated, category: fixedCategory, kind: fixedKind, validAt: fixedValidAt });
  }

  // 分节候选：正文按 ## 标题拆
  const sections = splitSections(body);
  for (const sec of sections) {
    const [content, truncated] = truncate(sec.content, maxLength);
    candidates.push({ title: sec.title, content, sourceRef: name, truncated, category: fixedCategory, kind: fixedKind, validAt: fixedValidAt });
  }

  return {
    meta: { path: filePath, hash: hashFile(text), name, description },
    candidates,
  };
}

function truncate(s: string, maxLength: number = MAX_NOTE_LENGTH): [string, boolean] {
  const clean = s.replace(/\s+$/g, '');
  if (clean.length <= maxLength) return [clean, false];
  return [clean.slice(0, maxLength) + '…（原文超长已截断）', true];
}

function splitSections(body: string): Array<{ title: string; content: string }> {
  const lines = body.split('\n');
  const sections: Array<{ title: string; content: string }> = [];
  let current: { title: string; content: string[] } | null = null;

  for (const line of lines) {
    // 节标题：## 标题 或 独立成行的粗体（**标题**）——记忆文件两种风格都常见
    const m = line.match(/^##\s+(.*)$/) ?? line.match(/^\*\*(.+?)\*\*\s*$/);
    if (m) {
      if (current && current.content.join('\n').trim()) {
        sections.push({ title: current.title, content: current.content.join('\n').trim() });
      }
      current = { title: m[1]!.trim(), content: [] };
    } else if (current) {
      current.content.push(line);
    }
  }
  if (current && current.content.join('\n').trim()) {
    sections.push({ title: current.title, content: current.content.join('\n').trim() });
  }
  return sections;
}
