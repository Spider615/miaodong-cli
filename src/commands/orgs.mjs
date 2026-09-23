import { EXIT } from '../errors.mjs';
import { requireIdentities } from '../identity.mjs';
import { out, shortId } from '../output.mjs';

export const orgs = {
  summary: '列出各区身份能看到的企业',
  usage: 'md orgs',
  async run() {
    for (const identity of requireIdentities()) {
      out(`${identity.label}（${identity.origin}）· ${identity.user?.name || '未知用户'}`);
      for (const org of identity.orgs) {
        out(`  - ${org.name || '(无名)'} (${shortId(org.id)})${org.id === identity.currentOrgId ? '  ← 取身份时选中的' : ''}`);
      }
    }
    return EXIT.OK;
  },
};
