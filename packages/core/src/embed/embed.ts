// Embedding 接口：TS 端统一入口（M1 先 spawn sidecar，M2 起升级为常驻 stdio 服务）
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../../..'); // src/embed → 项目根
const WRAPPER = path.join(ROOT, 'scripts/embed-env.sh');

const INLINE = `
import json, sys
sys.path.insert(0, 'scripts')
from bge_m3_loader import BgeM3Embedder
texts = json.loads(sys.argv[1])
emb = BgeM3Embedder('.python/models/BAAI--bge-m3')
vecs = emb.embed(texts)
print(json.dumps(vecs))
`;

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export class SidecarEmbedder implements Embedder {
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out = execFileSync(WRAPPER, ['-c', INLINE, JSON.stringify(texts)], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      // 大批量（全量导入 100+ 条）向量 JSON 可能数 MB，默认 1MB 会 ENOBUFS
      maxBuffer: 64 * 1024 * 1024,
    });
    // loader 的 [bge-m3] 行走 stderr？确认：print 全在 stdout，取最后一行 JSON
    const last = out.trim().split('\n').at(-1)!;
    return JSON.parse(last) as number[][];
  }
}

// M1 用单例；M2 换常驻进程实现时保持接口不变
export const embedder: Embedder = new SidecarEmbedder();
