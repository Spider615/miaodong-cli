// md kb find（spec 3a §3.4）：一句话在知识库里的三路结果——
//   文字命中：FAQ 用 searchMode=text（含未审核），段落在本地逐段比对（不依赖段落接口的 keyword）；
//   语义最像：语义搜索的前 10 条，分数就是大模型知识库工具的分数（§2.3），未审核的不在索引里，只返回 0.8 以上的；
//   问题相似：相似度检查，未审核的也在内。
// --local：只在最近一次 pull 的副本里做文字查找，不发任何请求。
import { boolArg } from '../args.mjs';
import { EXIT, usage } from '../errors.mjs';
import { clip } from '../execs.mjs';
import { SEMANTIC_FLOOR, checkSimilarity, listFiles, listParagraphs, searchFaqs } from '../kb.mjs';
import { localCopies } from '../kb-store.mjs';
import { kbLine, pickKb, resolveKb, resolveOrg } from '../kb-target.mjs';
import { out } from '../output.mjs';

export const SNIPPET = 60;
const status = (f) => `${f.reviewed ? '已审核' : '未审核'}${f.duplicateStatus && f.duplicateStatus !== 'normal' ? ` · ${f.duplicateStatus}` : ''}`;
export const faqLine = (f) => `  #${f.id} ${f.question} [${status(f)}]${typeof f.similarity === 'number' ? ` ${f.similarity.toFixed(3)}` : ''}\n      答：${clip(f.answer, SNIPPET)}`;
const paraLine = (p) => `  段落 #${p.id}（${p.fileName ?? p.fileId}）[${p.status}] ${clip(p.content, SNIPPET)}`;

async function findLocal(org, query, text) {
  const copies = localCopies(org);
  if (!copies.length) throw usage('本机还没有这个知识库的副本', `先 md kb pull ${query}`);
  let kb;
  try {
    kb = pickKb(copies.map((c) => c.meta.kb), query);
  } catch (error) {
    if (error.code === 'kb_not_found') throw usage('本机还没有这个知识库的副本', `先 md kb pull ${query}`);
    throw error;
  }
  const copy = copies.find((c) => c.meta.kb.id === kb.id);
  const faqHits = copy.faqs.filter((f) => f.question.includes(text) || f.answer.includes(text));
  const paraHits = copy.paragraphs.filter((p) => p.content.includes(text));
  out(kbLine(org, kb));
  out(`本机副本（${copy.meta.pulledAt}）文字命中：FAQ ${faqHits.length} 条、段落 ${paraHits.length} 条`);
  for (const f of faqHits.slice(0, 20)) out(faqLine(f));
  for (const p of paraHits.slice(0, 20)) out(paraLine(p));
  return EXIT.OK;
}

export async function find(args) {
  const [query, text] = args._;
  if (!query || !text) throw usage('用法：md kb find <知识库> "<一句话>" [--local]');
  const org = await resolveOrg(args);
  if (boolArg(args, 'local')) return findLocal(org, query, text);
  const kb = await resolveKb(org, query);
  const { identity, orgId } = org;
  out(kbLine(org, kb));
  const textHits = kb.faqCount ? await searchFaqs(identity, orgId, kb.id, text, { mode: 'text', size: 20 }) : [];
  const paraHits = [];
  if (kb.fileCount) {
    for (const f of await listFiles(identity, orgId, kb.id)) {
      for (const p of await listParagraphs(identity, orgId, kb.id, f.id)) if (p.content.includes(text)) paraHits.push({ ...p, fileName: f.name });
    }
  }
  out(`文字命中：FAQ ${textHits.length} 条、段落 ${paraHits.length} 条`);
  for (const f of textHits) out(faqLine(f));
  for (const p of paraHits.slice(0, 20)) out(paraLine(p));
  if (!kb.faqCount) {
    out('语义最像、问题相似：这个库没有 FAQ。文件段落没有语义搜索接口，分数要用 md trial 看');
    return EXIT.OK;
  }
  const semantic = await searchFaqs(identity, orgId, kb.id, text, { mode: 'semantic', size: 10 });
  out(`语义最像（前 ${semantic.length} 条；只返回相似度 ${SEMANTIC_FLOOR} 以上的，未审核的不在语义索引里）：`);
  for (const f of semantic) out(faqLine(f));
  const similar = await checkSimilarity(identity, orgId, kb.id, text);
  out(`问题相似（含未审核，${similar.length} 条）：`);
  for (const f of similar) out(faqLine(f));
  return EXIT.OK;
}
