// md kb pull（spec 3a §3.3）：把一个知识库的全部 FAQ、文件、段落、网页拉到本机。
// 拉到的条数和平台显示的对不上就报错、不留副本：多半是秒懂接口的行为变了（比如 §2.2 第 1 条那种），这时的副本会误导排查。
// 条数对得上也要核对不重复的 id：翻页不稳时重复的和漏掉的正好抵消（整支审查小问题 3）。
// 平台没给条数（接口字段认不出）时照样拉，但说明哪几类没核对。
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
  const unchecked = [];
  const check = (label, rows, want, unit) => {
    if (want === null || want === undefined) unchecked.push(label.trim());
    else if (rows.length !== want) mismatches.push(`${label}拉到 ${rows.length} ${unit}，平台显示 ${want} ${unit}`);
    const uniq = new Set(rows.map((r) => r.id)).size;
    if (uniq !== rows.length) mismatches.push(`${label}拉到 ${rows.length} ${unit}，其中有重复（不重复的 ${uniq} ${unit}）`);
  };
  const faqs = await listFaqs(identity, orgId, kb.id);
  check('FAQ ', faqs, kb.faqCount, '条');
  const files = [];
  const paragraphs = [];
  for (const f of await listFiles(identity, orgId, kb.id)) {
    const d = await fileDetails(identity, orgId, kb.id, f.id);
    const ps = await listParagraphs(identity, orgId, kb.id, f.id);
    check(`文件「${f.name}」的段落`, ps, d.paragraphCount, '条');
    files.push({ ...f, ...d });
    paragraphs.push(...ps.map((p) => ({ fileId: f.id, fileName: f.name, ...p })));
  }
  check('文件', files, kb.fileCount, '个');
  const webs = await listWebs(identity, orgId, kb.id);
  check('网页', webs, kb.webCount, '个');
  if (mismatches.length) {
    throw new MdError('kb_count_mismatch', `拉到的条数和平台显示的对不上：${mismatches.join('；')}`, {
      hint: '多半是秒懂接口的行为变了；这份副本会误导排查，没有保存',
    });
  }
  const dir = savePull(org, kb, { faqs, files, paragraphs, webs });
  const pending = faqs.filter((f) => f.reviewed === false).length;
  const unknownReview = faqs.filter((f) => f.reviewed === null).length;
  const dup = faqs.filter((f) => f.duplicateStatus !== 'normal').length;
  out(kbLine(org, kb));
  out(`已存：${dir}`);
  out(`FAQ ${faqs.length}（未审核 ${pending}${unknownReview ? ` · 审核状态认不出 ${unknownReview}` : ''} · 疑似重复 ${dup}）· 文件 ${files.length}（未就绪 ${files.filter((f) => f.status !== 'ready').length}）· 段落 ${paragraphs.length}（未就绪 ${paragraphs.filter((p) => p.status !== 'ready').length}）· 网页 ${webs.length}`);
  if (pending) out(`⚠️ 未审核的 ${pending} 条 FAQ 检索不到`);
  if (unknownReview) out(`⚠️ ${unknownReview} 条 FAQ 认不出审没审核（接口字段可能改了），先在秒懂页面上看一眼`);
  if (unchecked.length) out(`⚠️ 平台没给这几类的条数（接口字段可能改了），没核对：${unchecked.join('、')}`);
  out(`查询：jq -c 'select(.reviewed == false)' ${dir}/faqs.jsonl；grep -n "关键词" ${dir}/*.jsonl`);
  return EXIT.OK;
}
