// 3b 导入的测试数据：「售后 FAQ」库里加一个带原文件的旧文件（601，要删了重建的那种）、一个带知识标签的文件（602）、一条带图的 FAQ（7010）
import { KB_FAQ, faqs, files, paragraphs } from './kb-fixtures.mjs';
import { doc, faq } from './kb-import-fixtures.mjs';

export const importFaqRows = () => [
  ...faqs(),
  { id: 7010, kb: KB_FAQ, question: '带图的问题', answer: '看图', isReviewed: true, materials: [{ url: 'https://x/a.png', type: 'image' }] },
];
export const importFileRows = () => [
  ...files(),
  { id: 601, kb: KB_FAQ, name: '旧价格表', extension: 'pdf', status: 'ready', abstract: '旧价格表的摘要' },
  { id: 602, kb: KB_FAQ, name: '带标签的文件', extension: 'pdf', status: 'ready', tags: [{ id: 't1', name: '售后' }] },
];
export const importParagraphRows = () => [
  ...paragraphs(),
  { id: 9101, fileId: 601, index: 0, content: '瑜伽月卡 299 元', wordCount: 9, status: 'ready' },
  { id: 9102, fileId: 601, index: 1, content: '瑜伽年卡 1999 元', wordCount: 10, status: 'ready' },
  { id: 9201, fileId: 602, index: 0, content: '标签文件内容', wordCount: 6, status: 'ready' },
];
export const importServerOptions = (extra = {}) => ({ writable: true, faqRows: importFaqRows(), fileRows: importFileRows(), paragraphRows: importParagraphRows(), ...extra });

// 顺利的包：加 1 条 FAQ（和 #7001 很像）、1 个新文件（2 段）；删 #7002 和旧价格表（601）
export const goodPackage = () => ({
  faqs: [faq('f1', '课程怎么退款呀', '在订单详情页申请，七个工作日内到账。')],
  docs: [doc('d1', '新价格表', ['瑜伽月卡 399 元', '瑜伽年卡 2999 元'])],
  deletes: [{ type: 'faq', id: 7002, question: '退款多久到账' }, { type: 'doc', id: 601, name: '旧价格表' }],
});
