// md kb pull（spec 3a §3.3）：把一个知识库的全部 FAQ、文件、段落、网页拉到本机。
// 拉到的条数和平台显示的对不上就报错、不留副本：多半是秒懂接口的行为变了（比如 §2.2 第 1 条那种），这时的副本会误导排查。
import { EXIT, MdError, usage } from '../errors.mjs';
import { fileDetails, listFaqs, listFiles, listParagraphs, listWebs } from '../kb.mjs';
import { savePull } from '../kb-store.mjs';
import { kbLine, resolveKb, resolveOrg } from '../kb-target.mjs';
import { out } from '../output.mjs';

export async function pull(args) {
  const query = args._[0];
  if (!query) throw usage('缺知识库：md kb pull <知识库>', 'md kb list 看这个企业有哪些知识库');
  const org = await resolveOrg(args);
  const kb = await resolveKb(org, query);
  const { identity, orgId } = org;
  const mismatches = [];
  const faqs = await listFaqs(identity, orgId, kb.id);
  if (faqs.length !== kb.faqCount) mismatches.push(`FAQ 拉到 ${faqs.length} 条，平台显示 ${kb.faqCount} 条`);
  const files = [];
  const paragraphs = [];
  for (const f of await listFiles(identity, orgId, kb.id)) {
    const d = await fileDetails(identity, orgId, kb.id, f.id);
    const ps = await listParagraphs(identity, orgId, kb.id, f.id);
    if (ps.length !== d.paragraphCount) mismatches.push(`文件「${f.name}」的段落拉到 ${ps.length} 条，平台显示 ${d.paragraphCount} 条`);
    files.push({ ...f, ...d });
    paragraphs.push(...ps.map((p) => ({ fileId: f.id, fileName: f.name, ...p })));
  }
  if (files.length !== kb.fileCount) mismatches.push(`文件拉到 ${files.length} 个，平台显示 ${kb.fileCount} 个`);
  const webs = await listWebs(identity, orgId, kb.id);
  if (webs.length !== kb.webCount) mismatches.push(`网页拉到 ${webs.length} 个，平台显示 ${kb.webCount} 个`);
  if (mismatches.length) {
    throw new MdError('kb_count_mismatch', `拉到的条数和平台显示的对不上：${mismatches.join('；')}`, {
      hint: '多半是秒懂接口的行为变了；这份副本会误导排查，没有保存',
    });
  }
  const dir = savePull(org, kb, { faqs, files, paragraphs, webs });
  const pending = faqs.filter((f) => !f.reviewed).length;
  const dup = faqs.filter((f) => f.duplicateStatus !== 'normal').length;
  out(kbLine(org, kb));
  out(`已存：${dir}`);
  out(`FAQ ${faqs.length}（未审核 ${pending} · 疑似重复 ${dup}）· 文件 ${files.length}（未就绪 ${files.filter((f) => f.status !== 'ready').length}）· 段落 ${paragraphs.length}（未就绪 ${paragraphs.filter((p) => p.status !== 'ready').length}）· 网页 ${webs.length}`);
  if (pending) out(`⚠️ 未审核的 ${pending} 条 FAQ 检索不到`);
  out(`查询：jq -c 'select(.reviewed == false)' ${dir}/faqs.jsonl；grep -n "关键词" ${dir}/*.jsonl`);
  return EXIT.OK;
}
